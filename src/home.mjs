// home.mjs — page module for the PR Review Tree dashboard.
// Fetches the blocks of a PR, mounts the BlockList sidebar, and owns the global
// up/down keyboard navigation through the flat list.

import { reactive, html, watch } from './vendor/arrow.js'
import BlockList, {
  isFullyApproved,
  isIgnoredComment,
  batchEligibleRows,
  checkedBatchComments,
  toggleBatchChecked,
} from './BlockList.mjs'
import { isBatchEligible, startCommentBatch } from './commentBatch.mjs'
import { testRun, syncTestRun, startTestRun, cancelTestRun, hasTestRunActivity, TEST_RUN_STATE_LABEL } from './testRun.mjs'
import { claudeStatusText } from './ClaudeChat.mjs'
import Footer, { footerBoxPx } from './Footer.mjs'
import ProgressBar, { PROGRESS_BAR_PX } from './ProgressBar.mjs'
import TopLoadingBar from './TopLoadingBar.mjs'
import { refreshScrollHints } from './scrollFade.mjs'
import Block, {
  blockRows,
  changedRows,
  changeGroups,
  diffStat,
  approvedRowSet,
  approvedCallSet,
  callKey,
  callUnitApproved,
  rowCallSegments,
  rowAnchorText,
  rowChanged,
  unitsFor,
  updateHints,
  blockLabel,
  singleSide,
  isImageFile,
  sweepBracketOnlyForward,
  translationRowUnits,
  fitCapCharsFor,
  blockDescCollapsible,
} from './Block.mjs'
import RelatedPanel, {
  InlineComments,
  ClaudeChatPanel,
  claudeChatVisible,
  claudeColumnVisible,
  TasksPanel,
  buildTaskRows,
  hideTaskLogLine,
  setTasksRefreshBusy,
  markTaskRetrying,
  clearTaskRetrying,
  enterCommentsOrRelated,
  startComment,
  startPrWideComment,
  isPrWideComposing,
  startClaudeChat,
  enterClaudeChat,
  sendClaudeChatText,
  startRangeComment,
  startRangeChat,
  createComment,
  placeComment,
  isComposeOpen,
  composeHasText,
  isConvertingAiWarning,
  relatedActive,
  leaveRelated,
  handleRelatedKey,
  isCodeFocused,
  isCommentOrThreadFocused,
  commentReplyEmpty,
  focusedCommentEl,
  deleteFocusedComment,
  deleteAllAiWarnings,
  resolveFocusedComment,
  unresolveFocusedComment,
  focusedCommentGithubId,
  focusedComment,
  convertWarningToComment,
  convertPrWideWarningToComment,
  commentRowSet,
  commentRangeRowSet,
  commentActivitySummary,
  commentListSnapshot,
  setCommentScope,
  setRelated,
  focusedRelatedChild,
  focusedChipChain,
  selectComment,
  indexComments,
  openChatComments,
  chatConversationIds,
  isOrphanComment,
  commentDetailCard,
  startPrCommentReply,
  cancelPrCommentReply,
  startPrCommentChat,
  startPrGeneralChat,
  isGeneralChatAnchor,
  resumeStuckClaudeAfterCheckout,
  resolvePrCommentItem,
  deletePrCommentItem,
  unresolvePrCommentItem,
  enterPrCommentThread,
  isPrCommentThreadFocused,
  exitPrCommentThread,
  handlePrCommentThreadKey,
  scrollIntoViewVertical,
  alignToTopVertical,
  isOwnMessage,
  startEditMessage,
  focusedThreadMessage,
  focusedPrThreadMessage,
  activeComposeTargetHint,
  composeTargetHint,
  CommentClaudeFooter,
  hasCommentClaudeFooter,
  hasAnyComments,
  isClaudeChatFocused,
  isFooterTasksFocused,
  activeClaudeMessageBody,
  clearClaudeChat,
  retryClaudeTurn,
  cancelClaudeTurn,
  claudeAnchorIsPlaceholder,
  convertClaudeAnchorToComment,
  isChatAnchorPlaceholder,
  setClaudeMenuOpener,
  selectHighlightedClaudeOption,
  hasHighlightedClaudeOption,
  selectHighlightedClaudeTask,
  setClaudeTaskJump,
  claudeChatShadowWarning,
  sendPendingReply,
  pendingPublishInfo,
  setReplyPublishMenuOpener,
  setCommentSelectRequest,
  needsPublishChoice,
  localReplyCount,
  publishThreadOnly,
  CodePreviewPanel,
  toggleCodePreviewExpanded,
  activeCodePreviewKey,
  setEditsJumpCallback,
  selectHighlightedEditLink,
  commentTitleOf,
  enterRelatedFromClaudeChat,
  firstReviewerReplyOnPlaceholder,
  setCommentMenuOpener,
  setPrCommentMenuOpener,
  commentClaudeShortcutHints,
  primeAnchorThreadScroll,
} from './RelatedPanel.mjs'
import { ShortcutHintBar } from './shortcutHints.mjs'
import { railButtonHTML } from './collapsedRail.mjs'

// COMMENT_CLAUDE_WIDE_BREAKPOINT_PX — the width at/above which
// comment-claude-row's two halves both render at full (doubled) width
// instead of ever collapsing one to a rail (state.commentClaudeNarrow's own
// threshold, see its doc comment). Verified against the reviewer's real
// MacBook viewport (1690×1054, DPR 2 — a 1710×1107 screen minus the browser
// chrome): 1690px must still collapse, 1920px must not, 1919px must still
// collapse — see the three viewport cases in
// tests/comment-claude-column-widths.spec.mjs. Deliberately NOT the same
// value as Tailwind's app-wide `narrow` screen (1399px, index.html) — that
// one keeps governing everything else it always did (diff-card widths,
// etc.); this is a wider, narrower-scoped cutoff for one specific
// side-by-side pair. Don't merge the two back together.
const COMMENT_CLAUDE_WIDE_BREAKPOINT_PX = 1920
import CommandMenu, { filterCommands } from './CommandMenu.mjs'
import { CallArrowsHost, setCallArrows, resettleCallArrows } from './callArrows.mjs'
import { setPrRepo } from './prContext.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { renderMarkdown } from './markdown.mjs'
import { commentMentionsMe } from './mentions.mjs'
import ImageLightboxHost, { initImageLightbox, isLightboxOpen, handleLightboxKeydown } from './imageLightbox.mjs'
import WorkDirOverlayHost, { initWorkDirOverlay, isWorkDirOverlayOpen, handleWorkDirOverlayKeydown } from './workDirOverlay.mjs'
import GeneralChatOverlayHost, {
  initGeneralChatOverlay,
  isGeneralChatOverlayOpen,
  handleGeneralChatOverlayKeydown,
  openGeneralChatOverlay,
} from './generalChatOverlay.mjs'
import { initTheme, themeToggleButton } from './theme.mjs'
import { t, syncUiLang } from './i18n.mjs'
import { ensureAutoWarn, autoWarnToggleButton, autoWarn } from './autowarn.mjs'
import { settingsButton } from './settingsLink.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import TestMethodsColumn from './TestMethodsColumn.mjs'
import { meLogin } from './avatar.mjs'
import { relativeTime } from './relativeTime.mjs'
// Only the fetch wrapper is needed here now: the rows themselves are rendered
// by the merged "Taken" block (TasksPanel, RelatedPanel.mjs), not by a separate
// problems card of our own — see "The Taken block" in
// .claude/docs/detail-layout.md.
import { fetchProblems } from './problems.mjs'
import { initDebugLog, logAction } from './debugLog.mjs'
import {
  loadColumnWidths,
  colWidthStyle,
  startColumnResize,
  resetColumnWidth,
  startKeyResize,
  clearColumnWidth,
} from './columnWidth.mjs'

initTheme()
syncUiLang()
initImageLightbox()
// Debug mode (off unless the reviewer switched it on, see src/debugLog.mjs):
// records this page load plus every following key/click, so Claude can replay a
// reported bug. It installs its own listeners — nothing in the nav chain below
// knows about it.
initDebugLog()

// The PR under review comes from the path. Two shapes, and the first one is the
// historical one, unchanged:
//
//   /pr/<id>                      → the PRIMARY repo (see repos.go)
//   /pr/<repo-name>/<id>          → another configured repo, named by its bare
//                                   repo name ("/pr/plug-and-pay-ops/12")
//
// Reindert chose the full repo NAME in the URL over the short internal key: a URL
// is read by humans, a run-ID prefix is not. The server canonicalizes whatever we
// send back in `repo=` (canonRepo accepts the name, the key or the full slug), and
// an unknown repo simply reads as the primary one.
//
// Without a PR there's nothing to show, so bounce to the overview page.
function prFromPath() {
  const m = location.pathname.match(/^\/pr\/(?:([^/]+)\/)?(\d+)/)
  return m ? { repo: m[1] ? decodeURIComponent(m[1]) : '', pr: parseInt(m[2], 10) } : null
}
const FROM_PATH = prFromPath()
const PR = FROM_PATH ? FROM_PATH.pr : null
// REPO is the repo NAME from the path ("" = the primary repo). Every per-PR
// request carries it as `repo=` (see repoQuery below).
const REPO = FROM_PATH ? FROM_PATH.repo : ''
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
// GITHUB_PR is the fallback PR URL, used until the prmeta read-model loads. The
// owner is the same for every repo slash reviews; only the repo name varies, and
// the path already carries it (REPO).
const GITHUB_PR = `https://github.com/plug-and-pay/${REPO || 'plug-and-pay'}/pull/${PR}`

// repoQuery is the `&repo=<name>` suffix every per-PR API call appends — empty
// for the primary repo, so a primary-repo request is byte-identical to what a
// single-repo build sent.
const repoQuery = REPO ? '&repo=' + encodeURIComponent(REPO) : ''
// Share it with the modules that build their own per-PR URLs (RelatedPanel,
// commentBatch, events) — see src/prContext.mjs.
setPrRepo(REPO)

// prUidHere is this page's PR identity when handing off to the overview page: the
// bare number for the primary repo (the historical form every existing link and
// test uses) and "<repo-name>#<n>" otherwise. The overview matches either that or
// its own "<owner/name>#<n>" spelling (see matchesPrRef there) — the path only
// gives us the repo NAME, never the owner, and inventing one would be a guess.
function prUidHere() {
  return REPO ? REPO + '#' + PR : String(PR)
}

const state = reactive({
  pr: PR,
  // repo — the repo NAME from the path ("" = the primary repo). Read-only for the
  // lifetime of the page, like `pr`.
  repo: REPO,
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
  // pageProblems — GET /api/problems (repo-wide, read-only), filtered
  // client-side to THIS pr: failed workflow runs plus mirrored glue-log lines
  // that never surfaced as a run at all (see buildTaskRows in
  // RelatedPanel.mjs, which merges these INTO the "Taken" block, and
  // pollProblems
  // below, and "mislukte taken ook zichtbaar op /pr/<id>" in
  // .claude/docs/detail-layout.md). Reused from the SAME /pr-overview
  // "Mislukte taken" building blocks (src/problems.mjs).
  pageProblems: { failedRuns: [], logErrors: [] },
  // taskFocus — while stop 1 (the PR-description column) owns the keyboard, the
  // KEY of the focused row in the "Taken" block, or '' when the description
  // card itself has the focus. A key, not an index: the merged list reorders
  // under its own polls, and an index snapshot would silently point at another
  // row (see "Snapshot a selection by stable ID" in
  // .claude/rules/conventions.md). Ephemeral UI state, deliberately not in the
  // URL — like showDescription, which it only ever means anything alongside.
  // See stepTaskFocus and "Walking into the Taken block" in
  // .claude/docs/keyboard-navigation.md.
  taskFocus: '',
  // sinceExpanded — the KEYS of the "Aanpassingen sinds jouw review" blocks the
  // reviewer opened up to read in full (Enter on the focused block, or a click
  // on it): each block is capped with a fade until then, see SINCE_TRUNCATE_AT
  // and sinceReviewSections. Ephemeral UI state like state.descriptionExpanded,
  // deliberately not in the URL.
  sinceExpanded: [],
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
  // children in the Onderliggende-code panel; unresolved drives the automatic
  // LLM search, and only `searching` shows the "zoeken…" pill (RelatedPanel.mjs
  // — `unresolved` on its own is not a running action).
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
  // drillCursorRef — the URL-facing mirror of EVERY level's own {gran, change}
  // cursor in state.drillCursor, not just the deepest one above — each entry
  // encoded as `${gran}:${change}`, joined with `>` (index-aligned with
  // drillRef's own id path). Unlike drillGran/drillChange this restores an
  // ANCESTOR (non-focused, rail-collapsed) drilled column's own cursor too:
  // it's invisible while collapsed, but it's exactly the position
  // findNextUnapproved's "return to an unapproved ancestor" step (see
  // .claude/docs/drilling.md) reads once the reviewer finishes the deeper
  // subtree and pops back out — without this an ancestor's cursor silently
  // reset to {group, 0} on every refresh, so "Ga terug" landed at the top of
  // the column instead of where the reviewer actually left it. Mirrored to
  // `?dcur=` by the same watch as drillGran/drillChange; restored via
  // drillCursorRefPending/applyDrillCursorRestoreAt, applied per level as
  // applyDrillRefRestore walks the path back in (or once that level's code
  // arrives, mirroring drillCursorPending's own deferral).
  drillCursorRef: '',
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
  // works purely in terms of `selected`. A synthetic comment-index item
  // (kind:'comment', see commentBlockItem) carries its own stable `.id`
  // (`comment:<id>`) here instead of a `file:line` — resolved back by
  // applyCommentRefRestore, since comment items load independently of
  // loadBlocks (RelatedPanel's own comment poll) and may not exist yet at the
  // usual blockRef-restore time.
  blockRef: '',
  // classMethodSel — index into the ACTIVE test-class row's `.methods` array
  // (see the "Grouping test methods per class" section in
  // .claude/docs/detail-layout.md). Only meaningful while
  // `state.blocks[state.selected]` is a synthetic `kind:'test_class'` row
  // (see testClassRowItem/recomputeLeftList) — curBlock() resolves through
  // this index so every existing block-centric mechanism (diff, approve,
  // comments, drilling, footer) keeps working unchanged on whichever method
  // is currently active, without needing to know about test classes at all.
  classMethodSel: 0,
  // testColumnFocused — whether the new "methodes"-kolom (stop 2b of the
  // left→right nav chain, between the pr-index and the diff — see
  // keyboard-navigation.md) currently owns ↑/↓/→/Enter, as opposed to the
  // pr-index itself (stop 2). Only meaningful while the selected row is a
  // test_class row and state.mode === 'list'. Ephemeral, like
  // showDescription/toggleFocused — reset on every selection change.
  testColumnFocused: false,
  // testMethodRef — the URL-facing identity of the ACTIVE method within the
  // selected test_class row (`${file}:${line}`, mirrors blockRef itself) —
  // '' whenever the selection isn't a test_class row. Lets `?sel=testclass:…`
  // restore not just which class but which method was open, the same
  // "mirror by stable reference, not by array index" reasoning as blockRef/
  // drillRef (see applyTestMethodRefRestore below).
  testMethodRef: '',
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
  // rangeAnchor — the unit index a Shift+ArrowDown/ArrowUp multi-unit selection
  // started from, or null when no such range is active. Only meaningful while
  // gran is 'line' or 'group' (see isRangeGran): extendRange is the only place
  // that sets it, and every plain (non-shift) navigation/zoom/block-switch path
  // clears it back to null (see clearRangeAnchor). rangeUnit() merges it with
  // the current `change` into the { start, end } row range that approve/
  // comment/highlighting act on. The drilled-column equivalent lives per-entry
  // on state.drillCursor[i] (see drillExtendRange) rather than here.
  rangeAnchor: null,
  // listAnchor / methodAnchor are rangeAnchor's counterparts one level up, for
  // the SIDEBAR cursor instead of the diff cursor: Shift+ArrowDown/ArrowUp in
  // the block index (listAnchor, an index into state.blocks) resp. in the
  // methodes-kolom (methodAnchor, an index into the selected test_class row's
  // .methods) select a contiguous RANGE of rows, which an action can then act
  // on in one go — see extendListRange/extendMethodRange and
  // toggleRangeApproval. Both are ephemeral (never in the URL, like
  // rangeAnchor) and cleared by every plain, non-shift selection change
  // (clearListAnchor, called from selectRow and friends).
  listAnchor: null,
  methodAnchor: null,
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
  // langSiblings — per TRANSLATION block id → [{ locale, file, text }] of the
  // OTHER locale files of the same lang file (GET /api/langsiblings, read-only).
  // Fed into Block.mjs's translationSlot as extra, read-only columns on every
  // per-key row of the SELECTED translation block (see translationDiff.mjs's
  // translationBlockView) — one column per sibling locale, showing that
  // locale's current value for the same key. Reassigned wholesale so
  // Block.mjs's own nested TRANSLATION slot re-renders when it loads.
  langSiblings: {},
  // approvalSummaries — per top-level block id → { done, total } combined
  // approval count of the block *and every PR block nested under it* (its
  // relation children + resolved-call definitions). Computed off-render in a
  // watch (see below) and read by the sidebar, so the sidebar never subscribes
  // to each block's reactive b.code (which would re-trigger the diff
  // "stuck on loading" race). Reassigned wholesale so arrow.js re-renders.
  approvalSummaries: {},
  // underlyingIds — plain { blockId: true } map of the relation children that
  // recomputeLeftList keeps in state.blocks but sorts to the bottom of the
  // index, under the "Onderliggende code" heading (BlockList.mjs). Reassigned
  // wholesale together with state.blocks. A plain object, not a Set — a
  // reactive-proxied Set throws (see the viewedFiles note below).
  underlyingIds: {},
  // approvalTotal — the PR-wide { done, total } combined-approval count shown in
  // the "Start" header. Summed over every top-level block's subtree count in the
  // same off-render watch that fills approvalSummaries (a plain snapshot, so the
  // header never co-subscribes to any block's b.code).
  approvalTotal: { done: 0, total: 0 },
  // commentActivity — per state.blocks id → { count, last: {name, avatarUrl} }
  // for every OPEN comment thread anchored on the block itself or anywhere in
  // its PR-block subtree (see commentScopeKeys + the decoupled watch further
  // down). Same off-render/wholesale-reassign shape as approvalSummaries, for
  // the same reason — the sidebar must never co-subscribe to a block's b.code.
  commentActivity: {},
  // blockTotals — per block id → the number of changed rows a reviewer must
  // approve (the "total"), computed server-side (GET /api/blockstats). Authoritative
  // and known immediately, so done/total is right before a block's code lazily
  // loads; blockApproveCount prefers it and falls back to the client-side count.
  blockTotals: {},
  // showApproved — when false (default) fully-approved top-level blocks are hidden
  // from the starting-points list, revealed by the "Toon N goedgekeurde blokken"
  // button at the bottom. Ephemeral UI state, not bound to the URL.
  showApproved: false,
  // lineCommentsCollapsed — when true, hides the rows of the "Comments op
  // regels" section (BlockList.mjs's lineCommentHeading/renderList) without
  // touching any other toggle. Shown expanded by default (false), the
  // opposite default of showApproved — reviewer request: "laat het by
  // default zien, behalve als je het inklapt". Ephemeral UI state, not bound
  // to the URL, like showApproved.
  lineCommentsCollapsed: false,
  // pinnedApprovedId — the id of a fully-approved block that a restored
  // ?sel=file:line (see applyBlockRefRestore/revealSelectedIfHidden) happened
  // to land on. BlockList.mjs's renderList keeps exactly that ONE row visible
  // (a per-row exception, alongside i === state.selected) WITHOUT unfolding
  // every other approved block via showApproved — see revealSelectedIfHidden.
  // Deliberately never set by the live approve flow (approving the block
  // you're currently looking at still hides it immediately, unchanged
  // behaviour — see tests/selected-reveal-hidden.spec.mjs). Ephemeral, not
  // bound to the URL.
  pinnedApprovedId: null,
  // toggleFocused — true once ↓ has walked the list-mode keyboard cursor past
  // the last visible block onto the toggle-approved button itself (see
  // stepListSelection). Not a block, so `state.selected` stays put underneath
  // it — this is purely an extra, final stop in the ↑/↓ chain. Ephemeral, not
  // bound to the URL, like showApproved above.
  toggleFocused: false,
  // ignoreToggleFocused — the same idea as toggleFocused above, but for the
  // toggle-ignored button ("Toon N verborgen comments"): true once the
  // keyboard cursor sits on THAT row instead of a block. Mutually exclusive
  // with toggleFocused and with searchActive (see stepListSelection/
  // searchStepSelection, which always clear the other stops on every
  // transition). Ephemeral, not bound to the URL.
  ignoreToggleFocused: false,
  // pushTodoFocused — the same idea again, for the push-todo row at the very
  // bottom of the index ("N commit(s) nog niet gepusht", see pushTodoRow in
  // BlockList.mjs): true once the keyboard cursor sits on THAT row. Mutually
  // exclusive with the two stops above and with searchActive. Ephemeral.
  pushTodoFocused: false,
  // batchChecked — { commentId: false } of comments the reviewer explicitly
  // UNchecked from the comment_batch selection (see batchCheckbox,
  // BlockList.mjs) — absence means checked, so every batch-eligible comment
  // starts checked, reproducing the removed 'bulkComments' palette's "hand
  // over everything" default. Ephemeral, session-only: unlike ignoredComments
  // this is a momentary curation of ONE upcoming run, not a durable reviewer
  // decision, so it's neither persisted nor bound to the URL. Reassigned
  // wholesale on every toggle so arrow.js re-renders (see toggleBatchChecked).
  batchChecked: {},
  // batchRowFocused — the same idea as toggleFocused/ignoreToggleFocused/
  // pushTodoFocused above, for the bottom "Verwerk N comments met Claude"
  // action row (batchActionRow, BlockList.mjs): true once the keyboard cursor
  // sits on THAT row instead of a block. Sits between ignoreToggleFocused and
  // pushTodoFocused in the sidebar's ↑/↓ loop (see stepListSelection) because
  // that's also the row's render position — mirroring toggleFocused's own
  // spot for the row right above it. Ephemeral.
  batchRowFocused: false,
  // staleRowFocused — the mirror-image stop of toggleFocused/ignoreToggleFocused/
  // batchRowFocused/pushTodoFocused, but at the TOP of the sidebar's ↑/↓ loop
  // instead of the bottom: true once the keyboard cursor sits on the
  // "Nieuwe commits in deze PR" notice (staleTreeRow, BlockList.mjs) instead of
  // a block. Only ever reachable while state.blocksStale is true (see
  // stepListSelection) — ↑ off the topmost visible block lands here, ↓ off it
  // returns to the first block, ↑ again continues into the search box.
  // Ephemeral, not bound to the URL, like the other four.
  staleRowFocused: false,
  // pendingPush — the PR's landed-but-unpushed Claude edits, or null when
  // there are none (the normal state). Read from GET /api/pending-push
  // (pending_push.go): { headRef, sha, ahead, files, state, pushRunId, error }.
  // Drives the todo row at the bottom of the index AND the "ongepusht"
  // marking on the blocks whose file is in `files`. Refetched on the
  // pendingpush.changed SSE event and on every resync. Ephemeral, never in
  // the URL: it describes the repo's state, not a navigation position.
  pendingPush: null,
  // checkout — this PR's shared local checkout Claude edits directly for a
  // write turn (chat_checkout.go/todo/todo-local-checkout-chat-edits.md), or
  // null before the first load. Read from GET /api/chat/checkout:
  // { pr, runId, dir, dirName, branch, decision, stashPending }. Drives the
  // checkout chip in prInfoCard's pr-info-theme-row. Refetched on the
  // checkout.changed SSE event; ephemeral, never in the URL, same reasoning
  // as pendingPush above.
  checkout: null,
  // blocksStale — the server swapped this PR's blocks (an ingest refresh pulled
  // in new commits, or a re-ingest ran) AFTER this tab loaded them, so the whole
  // tree below is one version behind. Set by the blocks.changed SSE handler,
  // never cleared: the only way back to a fresh tree is the reload the notice
  // row offers (staleTreeRow, BlockList.mjs). Ephemeral and deliberately not in
  // the URL — it describes this tab's staleness, not a navigation position, and
  // a reloaded tab is by definition no longer stale.
  blocksStale: false,
  // ignoredComments — { blockId: true } of PR-comment index items (kind:'comment',
  // see commentBlockItem) the reviewer explicitly ignored via the "Ignore" action
  // in prCommentCommandsFor. Hidden by default from the "PR-comments" section,
  // revealed by their own "Toon N verborgen comments" toggle — a SEPARATE section
  // from the approved-blocks one above (a comment can be ignored without being
  // resolved, and vice versa). DURABLE, not ephemeral: restored on load by
  // loadIgnoredComments and written through the ignore_comment workflow by
  // toggleIgnoreComment (see .claude/docs/tembed-workflows.md). Not bound to
  // the URL either way — it's a reviewer decision, not a navigation position.
  // Reassigned wholesale so arrow.js re-renders.
  ignoredComments: {},
  // ignoreRunId — the Run ID of this PR's `ignore_comment` workflow (the
  // durable ignored-comments tracker), filled by loadIgnoredComments via
  // POST /api/workflows/ignore_comment. Every Ignore toggle signals to it;
  // empty (offline) makes persistIgnoredComment a no-op, so ignoring then
  // degrades to the session-only behaviour this feature replaced.
  ignoreRunId: '',
  // showIgnored — mirrors showApproved above, but for the ignoredComments section.
  showIgnored: false,
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
  // searchLoopFocused — true only while the search box is a DELIBERATE stop
  // of the sidebar's ↑/↓ loop (see stepListSelection/searchStepSelection),
  // never for the box's real DOM focus alone: the box also ends up focused
  // ambiently (a browser quirk — the sole text input gets focus on a fresh
  // load, well before any navigation) and while the reviewer is simply
  // typing a filter, neither of which is a "loop arrival". Set exclusively
  // by activateSearch, cleared by exitSearch/setSearch.
  searchLoopFocused: false,
  onSearch: setSearch,
  // onPushTodo — the push-todo row's click (and right-click) handler. A click
  // runs the same function a key runs (see .claude/docs/mouse-navigation.md):
  // it moves the keyboard stop onto the row and opens the same confirm menu
  // Enter opens, never the push itself. `opts` is forwarded to openMenu
  // unchanged — a plain click passes nothing, a right-click passes
  // `{native,x,y}` (see "The right-click context menu" in
  // command-palette.md), same shape as Block.mjs's onOpenMenu.
  onPushTodo: (opts) => {
    state.toggleFocused = false
    state.ignoreToggleFocused = false
    state.staleRowFocused = false
    state.pushTodoFocused = true
    openMenu('pushTodo', opts)
  },
  // onBatchRow — the batch action row's click handler. A click runs the same
  // function the row's own Enter runs (see .claude/docs/mouse-navigation.md):
  // it moves the keyboard stop onto the row AND starts the run directly — see
  // startBatchFromRow's own doc comment for why this one has no confirm step.
  onBatchRow: () => {
    state.toggleFocused = false
    state.ignoreToggleFocused = false
    state.pushTodoFocused = false
    state.staleRowFocused = false
    state.batchRowFocused = true
    startBatchFromRow()
  },
  // onRowContextMenu — a sidebar row's right-click handler (BlockList.mjs's
  // row(), which lands the selection first, exactly like its own @click).
  // Resolves the SAME menu Enter would open on this now-selected row
  // (rightClickMenuMode — 'block' for an ordinary block, 'prComment' for a
  // comment-index item) and opens it native-styled at the cursor. A no-op
  // (native browser menu stays) while a real text field has focus, or when
  // rightClickMenuMode() finds nothing to open. See "The right-click context
  // menu" in command-palette.md.
  onRowContextMenu: (e) => {
    if (isEditableFocused()) return
    const mode = rightClickMenuMode()
    if (!mode) return
    e.preventDefault()
    openMenu(mode, { native: true, x: e.clientX, y: e.clientY })
  },
  // showDescription — stop 1 of the left→right nav chain (see
  // keyboard-navigation.md): the PR-info/description column, hidden by default so
  // it doesn't eat width. Only reachable from stop 2 (the block-index, ← ) and
  // only ever toggled while state.mode === 'list' (it sits to the left of the
  // sidebar, which itself only shows in list mode). Deliberately NOT bound to the
  // URL — ephemeral UI state, like `menu`/`ui.task`, not a navigation position a
  // refresh needs to restore.
  showDescription: false,
  // descriptionPinned / keepIndexInDiff — "keep this left column VISIBLE even
  // though the keyboard has moved past it, because it still fits". Both are
  // written only by applyDiffColumnFit (see its own doc comment) after a MOUSE
  // click into a diff: a click is an unambiguous "show me this diff" request,
  // not a step through the left→right nav chain, so nothing has to be given up
  // as long as the width is there. Reviewer request: "als er in de breedte
  // alles past, moeten we niets verbergen; past het niet, verberg dan eerst de
  // PR-omschrijving en daarna de PR-index."
  //
  // descriptionPinned is deliberately SEPARATE from showDescription rather than
  // widening that flag: showDescription doubles as "stop 1 owns the keyboard"
  // in a dozen places in onKeydown (Enter/Space/`/`/←/→ all branch on it), and
  // mode:'diff' + showDescription:true is exactly the invalid combination that
  // once left the keyboard stuck at stop 1. So showDescription keeps meaning
  // "stop 1 has the keyboard" unchanged, and PrInfoPanel renders on
  // `showDescription || descriptionPinned` — visibility, not ownership.
  descriptionPinned: false,
  // keepIndexInDiff does the same for the pr-index (<aside>), which otherwise
  // collapses to width 0 for every diff (see BlockList.mjs). Only ever true in
  // diff mode, and reset by enterDiff so the KEYBOARD path (→ out of the list)
  // keeps behaving exactly as before — stepping right past the index hides it,
  // per the nav chain.
  keepIndexInDiff: false,
  // blockIndexEntered — whether the reviewer has actually stepped INTO the
  // block index during this session, as opposed to state.selected merely
  // holding its just-loaded default (0) or the fresh-open automatic
  // applyDefaultUnapprovedSelection pick. Only flips to true at a real
  // stop-1 <-> block-index crossing (the ArrowRight/ArrowLeft branches around
  // showDescription toggles, and a direct row click) — never by the load
  // path itself. Ephemeral, like showDescription, and used ONLY to gate the
  // ordinary block row highlight while state.showDescription is true: on a
  // genuinely fresh open (no ?sel=) the reviewer is looking at the PR
  // summary, so no block row should read as "selected" underneath it — see
  // rowFocused in BlockList.mjs and .claude/docs/keyboard-navigation.md.
  // Deliberately NOT applied to toggleRow — see its own comment in
  // BlockList.mjs for why.
  blockIndexEntered: false,
  // indexHandedOff — mirrors relatedActive() (RelatedPanel.mjs's "does the
  // right-hand panel own the keyboard") onto `state`, purely so BlockList can
  // read it: BlockList must NOT import RelatedPanel, which already imports
  // BlockList (statusInfo/categoryClass), so a direct call would close an
  // import cycle. Kept in sync by the watch next to the selection watches
  // below. The only consumer is the sidebar row's own "selected, but the
  // arrows have moved on" styling — see rowFocused/rowHandedOff in
  // BlockList.mjs and "Only one thing reads as selected" in
  // .claude/docs/comments-panel.md. Ephemeral, like blockIndexEntered.
  indexHandedOff: false,
  // commentAnchorEntered — the authoritative "has the reviewer pressed →
  // once yet" bit for an anchored comment-index item's own drilled column
  // (openCommentAnchorDrill). Reviewer request: "als ik 1 keer naar rechts
  // ga, selecteer code, als ik 2 keer naar rechts ga selecteer dan eerste
  // openstaande comment" — a single → used to jump straight into the
  // comments (enterCommentsOrRelated), skipping the "just show the code as
  // entered" stop every ordinary block gets. False the moment a (different)
  // comment-index item is selected (reset alongside commentAnchorDrillFor,
  // see the state.selected watch below) and true from the first → onward,
  // regardless of whether relatedActive() has since become true too — see
  // commentAnchorAwaitingEntry. Ephemeral, like indexHandedOff, not bound to
  // the URL: a refresh re-requires the first →.
  // Second consumer: BlockList.mjs collapses the pr-index while this is true,
  // so stepping right out of a comment-index item slides that index away just
  // like entering an ordinary block's diff does (list mode never triggers its
  // own collapse) — set on a mouse entry too, via the state.indexHandedOff
  // watch below.
  commentAnchorEntered: false,
  // descriptionExpanded — whether the PR description (Omschrijving) in the
  // PR-info column is shown in full or truncated (the default). Toggled by both
  // the "Toon volledige omschrijving"/"Omschrijving inklappen" PR-menu item and
  // the in-card "meer…"/"Inklappen" affordance — one flag, so they stay in
  // lockstep. Ephemeral UI state, NOT bound to the URL (like showDescription).
  descriptionExpanded: false,
  // descFocusId / descExpanded — the BLOCK description strip (Block.mjs's
  // `block-description`), which is its own keyboard stop inside stop 3: ↑ from
  // the block's first change lands here (one extra step) instead of flowing
  // straight into the previous same-file block, Enter opens the 2-line cap to
  // the full text and ↓ goes back to the first change. See "The block
  // description is an extra ↑ stop above the first change" in
  // .claude/docs/keyboard-navigation.md.
  //
  // descFocusId holds the BLOCK ID whose strip has the cursor ('' = none), and
  // descExpanded the ids that are currently opened out — ids, never an index
  // (see "Snapshot a selection by stable ID" in .claude/rules/conventions.md),
  // and deliberately also never `state.selected`: Block.mjs's two strip
  // bindings must depend on nothing that an ordinary ↑/↓/f step changes, or
  // every diff step would re-set that strip's class attribute (which
  // tests/navigate.spec.mjs asserts never happens). Both ephemeral, NOT bound
  // to the URL — a cursor/disclosure position, like descriptionExpanded and
  // sinceExpanded above it.
  descFocusId: '',
  descExpanded: [],
  // diffViewMode — the global diff-pane preference, cycled everywhere with `a`
  // (onKeydown, DIFF_VIEW_CYCLE below): 'split' (default, old+new side by
  // side) → 'unified' (a genuinely two-sided block collapses to ONE column,
  // old (-) directly above new (+) — see Block.mjs's unifiedCodeDiff) →
  // 'fit' (only the new/right pane — old code is never shown, even for a
  // two-sided block, see Block.mjs's fitOnly) → back to 'split'. Every
  // stand's card width follows the code actually around the cursor rather
  // than a fixed tier (Block.mjs's widthCls/contentWidthCls). Read by every
  // visible Block()
  // card (the selected/preview cards and every open drilled column) via its
  // viewMode opt — see Block.mjs's codeDiff. Ephemeral UI state, not bound to
  // the URL, like showDescription/showApproved above.
  diffViewMode: 'split',
  // explanations — the AI unit-explanation read-model (GET /api/explanations):
  // per `${blockId}|${unitKey}` an entry { codeHash, status, text }, generated
  // by the explain_code workflow (Opus) for any line/group unit the reviewer
  // navigates to. Reassigned wholesale on every load so the footer watch
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
  // footerExplain is the AI description of the focused unit
  // ({ status: 'searching'|'done', text }, null when the unit has no code /
  // the generation failed / not in diff mode). Both are ephemeral (never in
  // the URL).
  footerUnit: null,
  footerExplain: null,
  // footerVisible — derived by updateFooter(): true once footerUnit or
  // footerExplain has something to show. The footer bar (Footer.mjs) and
  // every bottom-reservation binding (DetailPanel, RelatedPanel's sidebar/
  // rail) read this instead of state.mode, so the bar + its reserved space
  // disappear entirely rather than showing an empty balk.
  footerVisible: false,
  // mainOverflowRight — true while <main>'s own column flow (detail-panel)
  // has content scrolled out of view to the right, i.e. there is more to
  // reach with a rightward scroll. Kept in sync by an IntersectionObserver
  // watching a 1px sentinel appended as <main>'s own last child (see
  // mainOverflowSentinel below) rather than hand-recomputed at every
  // navigation/layout call site — the sentinel reacts to ANY change in
  // <main>'s total content width (a column appearing/disappearing, the
  // description column opening, a drilled column, a manual column-width
  // resize) for free. Drives mainScrollRightHint's visibility; see "A mouse
  // way to reach content overflowing to the right" in detail-layout.md.
  mainOverflowRight: false,
  // mouseActiveHints — true while the mouse has moved ANYWHERE on the page
  // within the last 5s (see the window `mousemove` listener next to the
  // keydown/keyup/blur wiring below). Reviewer request: `main-scroll-left-
  // hint`/`main-scroll-right-hint` (below) used to reveal only on a direct
  // per-element CSS `hover:`, which made the always-visible "terug"/"verder"
  // rail undiscoverable unless the mouse happened to land exactly on its
  // small fixed-corner box. This flag ORs into that same opacity — see
  // "A mouse way to reach content overflowing to the right"/"...hidden to
  // the left" in detail-layout.md.
  mouseActiveHints: false,
  // colWidths — per-column manual width override in px, keyed
  // `${kind}:${id}` (kind ∈ 'diff'|'related'|'claude'|'comments'; id is a
  // block's stable b.id for 'diff', `${file}:${line}` for the other three —
  // see columnWidth.mjs). Hydrated from a 30-day cookie right after
  // construction (below), NOT from the URL/localStorage — a deliberate,
  // per-block choice, see .claude/docs/column-resize.md. Ephemeral in the
  // sense that it lives only in this reactive object; loadColumnWidths/
  // startColumnResize/resetColumnWidth persist every actual change straight
  // back to the cookie.
  colWidths: {},
  // colWidthVersion — bumped on every colWidths write. Adding a brand-new key
  // to a plain object is not reliably reactive on its own in this codebase's
  // arrow.js build (the same caveat as state.langSiblings elsewhere in this
  // file), so every reader voids this counter first instead of depending on
  // colWidths[key] directly.
  colWidthVersion: 0,
  // commentClaudeNarrow — reactive "is this window too narrow to keep BOTH
  // halves of comment-claude-row fully interactive at once" flag, gating
  // the comment↔Claude read-only shrink in RelatedPanel.mjs
  // (commentColumnReadOnly/claudeColumnReadOnly — see "Read-only, not a
  // rail" in .claude/docs/comments-panel.md): only a genuinely narrow window
  // ever shrinks the unfocused side to its read-only 1/3; a wide window
  // instead widens both halves (see commentColumnWidthCls/
  // claudeColumnWidthCls). Its threshold is
  // COMMENT_CLAUDE_WIDE_BREAKPOINT_PX (below), a DELIBERATELY SEPARATE,
  // wider cutoff from the app-wide `narrow:` Tailwind screen (1399px,
  // index.html's tailwind.config) — confirmed with the reviewer on a real
  // MacBook viewport (1690×1054) that sat ABOVE 1399px yet still needed to
  // collapse ("ik zit op mac, en het is te breed"). `narrow:` keeps
  // governing everything it already did (diff-card widths, etc.) — do NOT
  // fold this back onto that breakpoint, they answer two different
  // questions ("does the OS-level chrome have room" vs. "is this specific
  // side-by-side pair too cramped"). Needed as its own reactive field
  // because nothing else in this app re-renders purely because the window
  // resized with no other state change — every other width computation here
  // rides on Tailwind's own CSS media query, which needs no JS help, but
  // the rail-vs-full CHOICE swaps real markup and must therefore be
  // reactive.
  commentClaudeNarrow: window.innerWidth < COMMENT_CLAUDE_WIDE_BREAKPOINT_PX,
})

// A narrower window can take away the room a kept-open left column needed
// (see applyDiffColumnFit) — same module-level resize-listener shape as
// refreshHints()/repositionMenu() elsewhere in this file. Only re-checked
// while something IS being kept — widening the window never re-opens a
// column by itself, the reviewer asks for that with a click.
window.addEventListener('resize', () => {
  if (state.keepIndexInDiff || state.descriptionPinned) applyDiffColumnFit()
  // Guarded on the actual value (not a bare reassignment every resize tick,
  // which fires repeatedly while dragging) — the vendored proxy notifies on
  // every assignment regardless of whether the value truly changed, see
  // .claude/rules/arrowjs-pitfalls.md.
  const narrow = window.innerWidth < COMMENT_CLAUDE_WIDE_BREAKPOINT_PX
  if (state.commentClaudeNarrow !== narrow) state.commentClaudeNarrow = narrow
})

// Seed state.colWidths from the cookie set on an earlier visit. Cookies are
// available synchronously, unlike GET /api/me / GET /api/names (avatar.mjs),
// so this needs no async hydration dance — just a plain object merge before
// anything reads state.colWidths.
Object.assign(state.colWidths, loadColumnWidths())

// DIFF_VIEW_CYCLE is the fixed order `a` steps through — see state.diffViewMode
// above. 'unified' restructures a two-sided block into one "old above new"
// column (Block.mjs's unifiedCodeDiff); 'fit' hides the old pane entirely
// (Block.mjs's fitOnly, unlike 'unified' which still shows old code, just
// stacked). Every stand's card width is content-driven (Block.mjs's
// contentWidthCls), not a fixed tier.
const DIFF_VIEW_CYCLE = ['split', 'unified', 'fit']

// toggleDiffView steps state.diffViewMode to the next stand in DIFF_VIEW_CYCLE
// (see state.diffViewMode above). The reactive re-render rebuilds every
// visible pane's HTML (Block.mjs's codeDiff, .innerHTML) from scratch, which
// resets each pane's scrollTop to 0 — without re-centring, the diff jumps to
// the top of the function instead of staying on the active change. Not a
// navigation step, so no glide (mirrors ensureCode's `false` for a cached/
// already-loaded re-render, see detail-layout.md).
// This resizes every visible card (contentWidthCls(), Block.mjs)
// without touching state.selected/mode/gran/change, so the setRelated watch
// that normally drives the call-arrow overlay never fires — resettleCallArrows
// redraws the existing pairs at the new geometry, with the same immediate +
// 250ms-settle schedule callArrowPairs pushes use for the 200ms width
// transition (see detail-layout.md's "Call-pijl-overlay").
function toggleDiffView() {
  const idx = DIFF_VIEW_CYCLE.indexOf(state.diffViewMode)
  applyDiffViewMode(DIFF_VIEW_CYCLE[(idx + 1) % DIFF_VIEW_CYCLE.length])
}

// applyDiffViewMode sets state.diffViewMode to an explicit stand (instead of
// stepping to the next one) and runs the same follow-up as toggleDiffView —
// re-centre the diff (a pane re-render resets scrollTop) and resettle the
// call-arrow overlay. Shared by toggleDiffView (`a`) and setDiffViewMode (a
// click on the compact split/unified/fit indicator in Block.mjs's card header,
// see the "a — cycling the diff view" section in keyboard-navigation.md), so
// clicking a stand directly behaves exactly like cycling onto it with `a`.
function applyDiffViewMode(mode) {
  if (!DIFF_VIEW_CYCLE.includes(mode) || mode === state.diffViewMode) return
  state.diffViewMode = mode
  scrollChangeIntoView(false)
  resettleCallArrows()
}

// setDiffViewMode is the Block.mjs-facing callback (opts.setViewMode) — a
// click on one of the three indicator icons jumps straight to that stand.
function setDiffViewMode(mode) {
  applyDiffViewMode(mode)
}

// autoUnifiedForBlockRef — plain (non-reactive) bookkeeping: the ref of the
// top-level block the single-line auto-jump watch (below) already fired for,
// so a same-block re-render (a manual `a` cycle, an approve, a code
// re-fetch, …) never re-forces the stand back to 'unified' once the
// reviewer has deliberately switched away from it while still on this block.
let autoUnifiedForBlockRef = undefined

// allChangesAreSingleLine reports whether EVERY change group in `b`'s diff
// spans exactly one row (a changeGroups() unit with start === end) — i.e.
// the block never has a multi-line, contiguous change run. A block with no
// changes at all (an empty diff — its only reviewable content is its
// Onderliggende code, see enterDiff's own comment) is deliberately NOT such
// a block: there is nothing single-line about it either way.
function allChangesAreSingleLine(b) {
  const rows = blockRows(b)
  if (!rows.length) return false
  const groups = changeGroups(rows)
  return groups.length > 0 && groups.every((g) => g.start === g.end)
}

// allChangesAreAdditionsOnly reports whether a genuinely two-sided block's
// diff has no removed/replaced line anywhere (diffStat's del === 0) but at
// least one added one — i.e. every change is a pure insertion. singleSide(b)
// already forces such a block single-pane in EVERY stand (including split)
// when its status is added/removed, via effectiveOnly in Block.mjs's
// codeDiff — nothing to fix there, hence the singleSide(b) guard below.
// It's a 'modified'-status block (real old+new source, but zero deleted
// lines within the diff itself) where 'split' otherwise wastes its entire
// left/old pane (empty from the first changed row on) while the right/new
// pane runs the full width of every added line off the edge of its half.
function allChangesAreAdditionsOnly(b) {
  if (singleSide(b)) return false
  const rows = blockRows(b)
  if (!rows.length) return false
  const { add, del } = diffStat(rows)
  return add > 0 && del === 0
}

// Reviewer request: "als er in een blok elke keer maar 1 regel is aangepast,
// laat dan gelijk de -/+ view zien niet de side-by-side" — landing on such a
// block jumps state.diffViewMode to 'unified' as its INITIAL stand only.
// Second, independent trigger (2026-08-20, screenshot of
// Statistics\Config\config.php): "als er alleen dingen zijn toegevoegd wil
// ik de unified diff zien" — allChangesAreAdditionsOnly above covers this;
// it shares the exact same autoUnifiedForBlockRef guard/trade-offs, so
// landing on EITHER kind of block marks it "already decided" the same way.
// (explicitly confirmed option: not a permanent override — the reviewer can
// still cycle away with `a`/the indicator exactly as before, and it stays
// away for as long as this same block is selected). Scoped to the TOP-LEVEL
// selected block (state.focusLevel === 0, i.e. never while a drilled
// Onderliggende-code column owns the keyboard): state.diffViewMode is one
// global stand shared by every visible card (see diff-card.md's "There is no
// per-card stand"), so auto-jumping it while drilled would also flip
// column(s) this request never mentioned.
//
// Fires once per landing on a genuinely NEW block (autoUnifiedForBlockRef,
// keyed the same way lastSelectedBlockRef/lastFiredSelectionRef above are —
// by file:line, or a test_class row's own id for its active method) —
// deliberately not on every re-render of the SAME block. Needs the block's
// code loaded (blockRows/changeGroups both need it) — curBlock().code is
// listed inline so this re-fires once a fresh fetch (ensureCode) resolves,
// the same pattern the setCommentScope/setRelated watches above use.
//
// Known, accepted race: the ref is only marked as "handled" once the code
// has actually loaded (the `!b.code` guard below returns before that point),
// so a manual `a`/indicator click that lands WHILE the code is still
// fetching can be silently overridden once this watch gets its first real
// look at the freshly-arrived code. In practice code arrives well before a
// reviewer could reach for the toggle, so this is not fixed here — see
// tests/diffview.spec.mjs / mouse-approve.spec.mjs / navigate.spec.mjs /
// drill-focus.spec.mjs / comment-range-bar.spec.mjs / command-menu.spec.mjs /
// select-all-shortcut.spec.mjs's own "force split back" steps, which all
// wait for the code to render first for exactly this reason.
watch(
  () => [
    state.selected,
    state.mode,
    state.focusLevel,
    state.classMethodSel,
    state.blocks,
    curBlock() && curBlock().code,
  ],
  () => {
    if (state.mode !== 'diff' || state.focusLevel !== 0) return
    const b = curBlock()
    if (!b || b.kind === 'comment' || !b.code || b.code.error) return
    const row = curTestClassRow()
    const ref = row ? row.id : `${b.file}:${b.line}`
    if (ref === autoUnifiedForBlockRef) return
    autoUnifiedForBlockRef = ref
    // A raster image is never a single-line/additions-only CODE change: its
    // whole "source" is one generated placeholder line (imagePlaceholderSide,
    // image_asset.go), which would trivially satisfy allChangesAreSingleLine
    // and silently flip the GLOBAL stand — for every code block afterwards
    // too. Its own stands mean something different anyway (imageSlot in
    // Block.mjs: side by side / overlay at 50% / only the new one), so
    // landing on one must leave the reviewer's stand alone.
    if (isImageFile(b)) return
    if (allChangesAreSingleLine(b) || allChangesAreAdditionsOnly(b)) applyDiffViewMode('unified')
  },
)

// isEditableFocused reports whether DOM focus currently sits on a text input —
// used to keep the `a` shortcut (a real letter a reviewer might type) from
// firing while typing into a field that isn't otherwise guarded by cs.focus
// (see the `a` handler in onKeydown for why that guard alone isn't enough).
function isEditableFocused() {
  const el = document.activeElement
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
}

// isModifiedKey reports whether Cmd (Mac) or Ctrl (Windows/Linux) is held —
// used by the single-letter shortcuts (a/f/d/s) to step aside for the
// browser/OS's own Cmd+A (select all) / Cmd+F (find) / Cmd+D (bookmark) /
// Cmd+S (save): `event.key` stays the bare letter regardless of the modifier,
// so without this check those shortcuts silently ate the native browser
// behavior even outside any editable field (isEditableFocused() only covers
// TEXTAREA/INPUT, not a plain, selectable diff/code pane). Deliberately
// doesn't check altKey/shiftKey — those don't collide with a native
// select-all/find/bookmark/save shortcut on any platform this app targets.
function isModifiedKey(e) {
  return e.metaKey || e.ctrlKey
}

// isNativeTextEditKey reports whether this keydown is a Cmd/Ctrl-modified key
// pressed while DOM focus really sits in a text field — i.e. a NATIVE caret /
// selection / editing command the app must never hijack: Cmd+←/→ (start/end of
// the line on Mac), Cmd+↑/↓ (start/end of the field), their Shift+ selecting
// variants, and macOS's emacs-style Ctrl+←/→. Reviewer report: "als ik in een
// textarea zit, dan kan ik niet cmd + left drukken, dan moet het werken zoals
// normaal". `onKeydown` returns on it before any other branch, so this is one
// guard for EVERY text field (comment composer/reply, Claude chat, the search
// box, the palette query) instead of a per-branch exception — the
// isEditableFocused() fallback further down already lets an unmodified,
// unclaimed key flow into the field; only relatedActive()'s and
// state.searchActive's own arrow branches sat in front of it and swallowed a
// modified arrow as navigation. The Cmd+[ / Cmd+] block-history chord
// (top of onKeydown) is checked BEFORE this guard and returns on its own, so
// it never reaches here regardless of focus — see "Cmd+[ / Cmd+]" in
// .claude/docs/keyboard-navigation.md.
function isNativeTextEditKey(e) {
  return isModifiedKey(e) && isEditableFocused()
}

// editableCaretCanMoveLeft reports whether a focused text field's caret sits
// strictly past the very start (there's a character — or a selection — to its
// left), meaning a plain/Option ArrowLeft has somewhere to go *within* the
// field. Used to decide whether ArrowLeft should move/word-jump the caret
// (leave it to the browser) or fall through to the existing "exit the
// field/panel" shortcuts below (relatedActive's ArrowLeft branch) — a caret
// already at position 0 (e.g. a freshly opened, still
// empty composer/reply field) has nothing to move left into, so ArrowLeft
// there keeps its long-standing "step back out" meaning instead. See also
// editableCaretCanMoveRight below, its mirror image for ArrowRight.
function editableCaretCanMoveLeft() {
  const el = document.activeElement
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return false
  try {
    return el.selectionStart > 0 || el.selectionEnd > 0
  } catch {
    return false
  }
}

// editableCaretCanMoveRight is the mirror image of editableCaretCanMoveLeft:
// reports whether a focused text field's caret sits strictly before the very
// end (there's a character — or a selection — to its right), meaning a
// plain/Option ArrowRight has somewhere to go *within* the field. Used so
// ArrowRight moves/word-jumps the caret (leave it to the browser) instead of
// being hijacked by relatedActive's ArrowRight shortcut below (e.g. entering
// a comment's thread) while there's still text to move
// into — only once the caret is already at the end does ArrowRight keep its
// existing nav meaning there.
function editableCaretCanMoveRight() {
  const el = document.activeElement
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return false
  try {
    return el.selectionStart < el.value.length || el.selectionEnd < el.value.length
  } catch {
    return false
  }
}

// caretVisualLineMarks measures which VISUAL (wrapped) line a character offset
// falls on inside a <textarea> — selectionStart/selectionEnd alone only give a
// linear character index, not which rendered row that is once the text wraps
// (a comment/Claude composer is exactly such a wrapping, multi-row field). It
// builds a hidden mirror <div> that reproduces every style influencing
// wrapping (font, content width via clientWidth — so an active vertical
// scrollbar is accounted for the same way it narrows the textarea's own
// content box — padding, white-space/wrap), inserts zero-width marker spans at
// the very start, at `pos`, and at the very end of the field's value, and
// returns their offsetTop. Comparing `pos` against `start`/`end` then tells
// editableCaretCanMoveUp/Down below whether the caret already sits on the
// first/last wrapped row.
function caretVisualLineMarks(el, pos) {
  const csEl = getComputedStyle(el)
  const mirror = document.createElement('div')
  const style = mirror.style
  style.position = 'absolute'
  style.visibility = 'hidden'
  style.top = '0'
  style.left = '-9999px'
  style.height = 'auto'
  style.boxSizing = 'border-box'
  style.border = '0'
  style.width = el.clientWidth + 'px'
  style.whiteSpace = 'pre-wrap'
  style.overflowWrap = 'break-word'
  for (const p of [
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
  ]) {
    style[p] = csEl[p]
  }
  document.body.appendChild(mirror)
  const value = el.value
  const mark = () => {
    const span = document.createElement('span')
    span.textContent = '​'
    return span
  }
  const startMarker = mark()
  mirror.appendChild(startMarker)
  mirror.appendChild(document.createTextNode(value.slice(0, pos)))
  const posMarker = mark()
  mirror.appendChild(posMarker)
  mirror.appendChild(document.createTextNode(value.slice(pos)))
  const endMarker = mark()
  mirror.appendChild(endMarker)
  const result = { start: startMarker.offsetTop, pos: posMarker.offsetTop, end: endMarker.offsetTop }
  document.body.removeChild(mirror)
  return result
}

// editableCaretCanMoveUp reports whether a focused <textarea>'s caret sits
// below the very first VISUAL (wrapped) line, meaning a plain ArrowUp has a
// line to move to *within* the field. Mirrors editableCaretCanMoveLeft's role
// but for the vertical axis — used so ArrowUp moves the caret up one wrapped
// line (leave it to the browser) instead of being hijacked by relatedActive's
// ArrowUp shortcut below, only falling through to that nav shortcut once the
// caret is already on the first line. Deliberately TEXTAREA-only: a plain
// INPUT never wraps, so ArrowUp there keeps its existing nav meaning, same as
// today. Collapses a selection to its start, matching how the browser itself
// collapses an ArrowUp press on a selection.
function editableCaretCanMoveUp() {
  const el = document.activeElement
  if (!el || el.tagName !== 'TEXTAREA') return false
  try {
    const marks = caretVisualLineMarks(el, el.selectionStart)
    return marks.pos !== marks.start
  } catch {
    return false
  }
}

// editableCaretCanMoveDown is the mirror image of editableCaretCanMoveUp: is
// there a wrapped line *below* the caret's current one. Collapses a selection
// to its end, matching how the browser collapses an ArrowDown press.
function editableCaretCanMoveDown() {
  const el = document.activeElement
  if (!el || el.tagName !== 'TEXTAREA') return false
  try {
    const marks = caretVisualLineMarks(el, el.selectionEnd)
    return marks.pos !== marks.end
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
  { key: 'drillCursorRef', param: 'dcur', default: '' },
  { key: 'testMethodRef', param: 'tmethod', default: '' },
  // `?tcol=1` mirrors ONLY a real stop-2b focus (state.testColumnFocused, the
  // methodes-kolom — see .claude/docs/test-class-grouping.md), so a refresh
  // hands ↑/↓ straight back to that column instead of silently to the
  // pr-index. Deliberately its own param rather than being inferred from
  // `?tmethod=`: that one is written for EVERY selected test_class row (the
  // mirror watch below always records which method is active), so treating it
  // as "the column had focus" would take ↑/↓ away from the index after every
  // refresh on a test class. default:false keeps it out of the URL entirely
  // until the reviewer actually steps into the column.
  {
    key: 'testColumnFocused',
    param: 'tcol',
    parse: (raw) => raw === '1',
    format: (v) => (v ? '1' : ''),
    default: false,
  },
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

// hadInitialSelParam snapshots, once, whether the URL carried a `?sel=` at
// all — independent of whether blockRefPending has since been consumed. A
// `?sel=comment:<id>` (see applyCommentRefRestore) can resolve out of order
// relative to loadBlocks: RelatedPanel's own comment poll sometimes lands
// BEFORE loadBlocks' /api/blocks fetch does, which already nulls
// blockRefPending. loadBlocks' own `hadSelParam` check must still see "yes,
// there was a sel param" in that case — reading `blockRefPending != null`
// there directly would flip to false and wrongly let
// applyDefaultUnapprovedSelection override the just-restored selection.
const hadInitialSelParam = blockRefPending != null

// testMethodRefPending mirrors blockRefPending for the active method within a
// restored test_class row (`?tmethod=file:line`) — snapshotted before the
// mirror watch below (added alongside the blockRef watch) recomputes it back
// to '' against the still-empty state.blocks. Resolved synchronously inside
// applyBlockRefRestore's own `testclass:` branch (methods are already part of
// the loaded block, no separate async fetch needed, unlike a drilled child).
let testMethodRefPending = state.testMethodRef || null

// testColumnPending mirrors testMethodRefPending for `?tcol=1` (a real stop-2b
// focus, see the bindUrlState entry above). Snapshotted here because
// state.testColumnFocused is reset to false by every path that lands a
// selection (loadBlocks' own clamp, selectRow, clampSelectedToVisible) — all of
// which run BEFORE the restored `?sel=testclass:…` is resolved, so the value
// bindUrlState just restored would be wiped before it ever means anything.
// Applied by applyTestClassRefRestore, next to state.classMethodSel; null
// afterwards so it never hijacks later navigation.
let testColumnPending = state.testColumnFocused || null

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

// drillCursorRefPending mirrors drillCursorPending, but for EVERY level of the
// restored path (`?dcur=gran:change>gran:change>...`, see state.drillCursorRef's
// own comment) — snapshotted before the same mirror watch below can clobber it
// back to '' against the still-empty state.drill/drillCursor. An entry is
// consumed (set to null in place) by applyDrillCursorRestoreAt once applied, so
// a level whose code is still loading can be retried later without redoing the
// ones already applied. null when there's nothing to restore (no `?dcur=`, e.g.
// an older shared link that only carries dgran/dchg for the deepest level —
// applyDrillRefRestore falls back to drillCursorPending for that case).
let drillCursorRefPending = state.drillCursorRef
  ? state.drillCursorRef.split('>').map((entry) => {
      const [gran, change] = entry.split(':')
      return { gran: gran || 'group', change: Number(change) || 0 }
    })
  : null

// Keep blockRef mirroring the selected block (by file:line, not index) so a
// refresh/shared link restores the same block regardless of how the left
// list has since been filtered/reordered. Reads state.blocks/selected inline
// (the watch-getter convention — see conventions.md) so it reliably re-runs
// on every selection change. A synthetic comment-index item (kind:'comment',
// see commentBlockItem) has no file:line — it mirrors its own stable `.id`
// instead (`comment:<id>`, never colliding with a real block's `file:line`
// shape), so navigating through PR-wide comments also survives a refresh
// (see applyCommentRefRestore below for the restore side). A test_class row
// (see testClassRowItem/recomputeLeftList) mirrors the same way, on its own
// stable `.id` (`testclass:<file>::<class>`) — testMethodRef separately
// mirrors WHICH method within it is active (curBlock(), via
// state.classMethodSel), so both the class and the open method survive a
// refresh (see applyTestMethodRefRestore below for the restore side).
watch(
  () => [state.selected, state.blocks, state.classMethodSel],
  () => {
    const b = state.blocks[state.selected]
    state.blockRef = b ? (b.kind === 'comment' || b.kind === 'test_class' ? b.id : `${b.file}:${b.line}`) : ''
    const m = b && b.kind === 'test_class' ? b.methods[state.classMethodSel] : null
    state.testMethodRef = m ? `${m.file}:${m.line}` : ''
  },
)

// A stray "Beantwoorden"-revealed reply field, or a still-focused comment
// thread (see enterPrCommentThread), must never leak onto whatever gets
// selected next — reset both on every selection change (mirrors how the
// composer/reply focus elsewhere always resets on a block switch).
//
// A comment-index item (kind:'comment') also gets leaveRelated() — releasing
// the BLOCK-SCOPED panel's own cs.focus — for the same reason, but ONLY for
// that one kind, not on every selection change: commentScope()'s own `none`
// sentinel (home.mjs) forces RelatedPanel's cs.view to [] for ANY comment-
// index item, so cs.focus legitimately can never be 'comment'/'thread' there
// (isCommentOrThreadFocused() needs a resolvable selComment(), which can't
// exist) — resetting it here is always safe. A blanket reset on every
// state.selected change is NOT safe: recomputeLeftList can legitimately
// reindex the CURRENT, still-logically-unchanged selection out from under a
// background reload (a landed comment shifting every row by one, see
// conventions.md's "Snapshot a selection by stable ID, never by raw array
// index") — an earlier version of this fix did exactly that and broke
// tests/comment-nav-race.spec.mjs: a stale, unrelated placeComment tail
// settling on a DIFFERENT block reindexed state.selected for the block the
// reviewer was actually still on, which this watch then (wrongly) read as "a
// real navigation move" and wiped its live Onderliggende-code focus.
//
// The PR-comment Claude composer (startPrCommentChat, RelatedPanel.mjs) does
// not set cs.focus itself — so a stale
// cs.focus left over from a DIFFERENT block's comment/thread/claude panel
// (never explicitly exited via ←/Escape) used to survive a plain mouse click
// straight onto a comment-index item's "Chat met Claude" composer:
// home.mjs's global onKeydown still gated its whole relatedActive()-driven
// Enter/arrow handling on that stale value, unconditionally swallowing the
// very next Enter (reported bug: typing into that composer and pressing
// Enter did nothing, "fixed" by a refresh only because a cs.focus restored
// from the URL that resolves to nothing gets dropped, not because anything
// was actually repaired). Test: tests/pr-comment-claude-chat.spec.mjs's "a
// stale block-scoped cs.focus…" case.
//
// A genuine switch to a DIFFERENT ordinary block also gets leaveRelated() —
// second reported bug: chatting with Claude on block A (cs.focus === 'claude')
// and then landing on a different block B (e.g. a plain sidebar click, not
// one of the dedicated exits that already release the panel — →/←/Escape,
// ↓ at the bottom of the Claude chat) left cs.focus stuck at 'claude'.
// RelatedPanel.mjs's syncClaudeAnchorForSelection deliberately skips its own
// re-sync while cs.focus === 'claude' (so it never fights with an active
// conversation) — so block B's Claude column kept showing block A's stale
// transcript instead of B's own (or B's lack of one).
//
// lastSelectedBlockRef makes this identity-based, not index-based, for the
// same reason the comment-index branch above must stay scoped to that one
// kind: recomputeLeftList can reindex the CURRENT, still-logically-unchanged
// block out from under a background reload (see the paragraph above), and a
// bare index compare would misread that reindex as a real navigation move.
// Mirrors state.blockRef's own file:line/id computation just above, kept
// separate (plain module state, not reactive) so this watch's own "did the
// block actually change" check never depends on cross-watch ordering.
//
// undefined is the deliberate "no real block observed yet" sentinel — distinct
// from a genuine block's ref (always a non-empty string) or "nothing
// selected" (''). This watch can fire more than once while state.blocks is
// still loading (state.selected itself moving, e.g. clamped then restored to
// a specific index by loadBlocks/applyBlockRefRestore) with `b` undefined
// every time — recording a baseline THEN would make the first tick that
// finally sees a real block look like "a change" and call leaveRelated(),
// clobbering a genuinely restored cs.focus ('new'/'code'/…) that
// bindUrlState/applyRelRestore already applied from the URL (rel.foc=…)
// before or around that same tick — reported regression: a fresh
// rel.foc=new/code deep link (and a reload of one) lost its restored focus
// immediately. So the baseline is only ever recorded once `b` is truthy, and
// only a SUBSEQUENT, real block-to-block change may release the panel.
let lastSelectedBlockRef = undefined
// visitedCommentSinceOrdinary — true from the moment a comment/comment_group
// item is selected until the NEXT ordinary block/test_class row is landed on.
// lastSelectedBlockRef is deliberately never touched while a comment item is
// selected (see its own comment above — the comment branch is scoped to
// itself on purpose), so returning to the EXACT SAME ordinary block visited
// right before that comment reads as `ref === lastSelectedBlockRef` below and
// used to skip leaveRelated() entirely — even though the comment's own
// Claude chat (opened via that item's ArrowRight,ArrowRight) had since moved
// cs.focus to 'claude'. Reported bug: chatting with Claude on block A, then
// a PR-wide comment elsewhere, then clicking back on A left A's panel stuck
// showing the comment's stale conversation. This flag widens the ordinary
// branch's condition to also fire on an unchanged ref whenever a comment was
// visited in between, without touching the `lastSelectedBlockRef !== undefined`
// guard itself (still needed for "no baseline yet", see above).
let visitedCommentSinceOrdinary = false
// lastFiredSelectionRef guards the whole callback below against a SPURIOUS
// re-fire: arrow.js's reactive `set` trap notifies subscribers on every
// assignment, even one that writes back the exact same value (no old!==new
// check — see the LOCAL PATCH 3 area of src/vendor/arrow.js's `set` trap).
// recomputeLeftList() unconditionally does `state.selected = at` on every
// call, including a no-op reassignment to the already-selected index — which
// happens every 5s while a PR-comment index item is selected, since
// RelatedPanel.mjs's own comment-poll refreshTimer reassigns cs.list on that
// same cadence, which re-triggers the indexComments() watch just above, which
// calls recomputeLeftList(). Without this guard, that spurious 5s tick ran
// this callback again for the SAME comment item and unconditionally closed
// whatever "Beantwoorden"/thread/Claude-chat state the reviewer had just
// opened on it — reported bug: replying to a PR comment made the just-opened
// reply field disappear within a few seconds, before the reviewer could type
// anything. A genuine navigation still runs the full body below exactly as
// before; only an unchanged ref short-circuits. See the "watch() fires even on
// an unchanged value" entry in arrowjs-pitfalls.md.
let lastFiredSelectionRef = undefined
// commentAnchorDrillFor — plain (non-reactive) bookkeeping: the id of the
// comment-index ITEM (b.id, not a single comment's id — a row can now stand
// for a whole line-group, see commentBlockItem) that currently owns the ONE
// open drilled column via openCommentAnchorDrill (below). Lets the watch's
// cleanup branch tell "close what THIS feature opened" apart from "leave an
// ordinary drilled column (applyNextUnapproved/drillIntoChild/openTask)
// alone" — see that cleanup branch's own doc comment for why an
// unconditional clear there is wrong.
let commentAnchorDrillFor = null
// closeCommentAnchorDrillIfOwned closes a comment-anchor drill left open by a
// PREVIOUSLY selected item, but ONLY if THIS feature is the one that opened
// it (commentAnchorDrillFor) — never an ordinary, unrelated drill another
// code path (applyNextUnapproved's "Ga door", drillIntoChild, openTask) is in
// the middle of setting up via the very same state.selected change (arrow.js
// runs a watch's callback asynchronously, once the whole synchronous caller
// has already finished — an unconditional clear here would wipe such a drill
// the instant it opened, see drill-mode-flip.spec.mjs). Shared by both
// branches of the watch below, since landing on ANY different item — another
// comment/comment_group row included, now that a drill only opens via an
// explicit ArrowRight rather than automatically (see openCommentAnchorDrill's
// own doc comment) — must close a drill opened for the one left behind.
function closeCommentAnchorDrillIfOwned() {
  if (!commentAnchorDrillFor) return
  state.drill = []
  state.drillCursor = []
  state.focusLevel = 0
  commentAnchorDrillFor = null
  state.commentAnchorEntered = false
}
// blockHistoryStack/blockForwardStack/navigatingViaHistory — Cmd+[ / Cmd+]'s
// own "previous selected block" stack. SECOND reversal of this chord's
// mechanism (nav-chain remap -> real browser history in c2acbc7 -> this
// stack, reviewer-driven each time — see the "Cmd+[ / Cmd+]" section in
// keyboard-navigation.md, do not flip this back to real browser history
// again). Ephemeral, plain module state, deliberately NOT mirrored to the
// URL or any storage — explicit reviewer answer: "de stack hoeft een
// refresh niet te overleven", so a reload always starts both stacks empty
// again (same category as commentAnchorDrillFor/visitedCommentSinceOrdinary
// above). blockHistoryStack/blockForwardStack hold refs in the exact shape
// state.blockRef/lastFiredSelectionRef already use (file:line /
// comment:<id> / testclass:<file>::<class>); navigatingViaHistory is set
// for the duration of a goToPreviousBlock/goToNextBlock-driven
// state.selected change so the watch above doesn't record its OWN step as a
// new move (which would also wrongly wipe the other stack).
let blockHistoryStack = []
let blockForwardStack = []
let navigatingViaHistory = false

// resolveRefToIndex mirrors applyBlockRefRestore/applyCommentRefRestore/
// applyTestClassRefRestore's own per-kind lookup, reused here to resolve a
// stack entry back to a live index — a stack entry can point at a block
// that no longer exists any more (a re-ingest, a comment that got resolved
// and dropped out of the index) by the time Cmd+[/] is pressed, so callers
// must be ready for -1.
function resolveRefToIndex(ref) {
  if (ref.startsWith('comment:')) return state.blocks.findIndex((b) => b.kind === 'comment' && b.id === ref)
  if (ref.startsWith('testclass:')) return state.blocks.findIndex((b) => b.kind === 'test_class' && b.id === ref)
  return state.blocks.findIndex((b) => b.kind !== 'comment' && b.kind !== 'test_class' && `${b.file}:${b.line}` === ref)
}

// goToPreviousBlock / goToNextBlock — Cmd+[ / Cmd+]'s own action (onKeydown
// below). "Vorige blok waar ik iets had geselecteerd" — a stack of TOP-LEVEL
// selections only (state.selected moving to a different row), never a
// group/line/call granularity step within the same block, a drilled column,
// or a comment thread/Claude focus — see the push site in the
// state.selected watch above for why that's automatic (none of those touch
// state.selected). An EMPTY stack means nothing has been visited yet this
// session (a fresh load, or every recorded step already undone) — falls
// through to a real navigation to /pr-overview (this app has no
// client-side router between the two pages, see pages-and-routing.md), not
// a no-op; an empty FORWARD stack, by contrast, is an ordinary no-op — there
// is no equivalent "go forward past the start" destination.
function goToPreviousBlock() {
  while (blockHistoryStack.length) {
    const ref = blockHistoryStack.pop()
    const idx = resolveRefToIndex(ref)
    if (idx < 0) continue // the tree changed since this was recorded — try the next one back
    if (lastFiredSelectionRef != null) blockForwardStack.push(lastFiredSelectionRef)
    navigatingViaHistory = true
    state.selected = idx
    return
  }
  location.href = '/pr-overview'
}
function goToNextBlock() {
  while (blockForwardStack.length) {
    const ref = blockForwardStack.pop()
    const idx = resolveRefToIndex(ref)
    if (idx < 0) continue
    if (lastFiredSelectionRef != null) blockHistoryStack.push(lastFiredSelectionRef)
    navigatingViaHistory = true
    state.selected = idx
    return
  }
  // Nothing to redo — a plain no-op, mirroring a real browser's own Cmd+]
  // with an empty forward history.
}


watch(
  () => state.selected,
  () => {
    const b = state.blocks[state.selected]
    const fireRef = b ? (b.kind === 'comment' || b.kind === 'test_class' ? b.id : `${b.file}:${b.line}`) : null
    if (fireRef !== null && fireRef === lastFiredSelectionRef) return
    // Cmd+[ / Cmd+]'s own selection-history stack (goToPreviousBlock/
    // goToNextBlock below) — push the ref being LEFT onto blockHistoryStack,
    // but only for a genuinely NEW move: this watch already guarantees "a
    // top-level selection change" (a same-block granularity/drill/thread
    // change never touches state.selected at all, see the doc comments
    // above), and navigatingViaHistory (set by goToPreviousBlock/
    // goToNextBlock themselves) tells a back/forward step apart from an
    // ordinary one so undoing a step never re-records itself.
    if (navigatingViaHistory) {
      navigatingViaHistory = false
    } else if (fireRef !== null && lastFiredSelectionRef != null) {
      blockHistoryStack.push(lastFiredSelectionRef)
      blockForwardStack = [] // a genuinely new move discards any redo history
    }
    lastFiredSelectionRef = fireRef
    cancelPrCommentReply()
    exitPrCommentThread()
    if (b && b.kind === 'comment') {
      // Unconditional, even before a baseline exists — unlike the ordinary-
      // block case below, cs.focus/the keyboard can NEVER legitimately be
      // already inside a comment/comment_group row's OWN panel the moment it
      // is merely selected — a restored value here is never worth
      // preserving.
      leaveRelated()
      // A genuinely new comment-index selection always starts back at
      // "awaiting entry" — a stale commentAnchorEntered from the PREVIOUSLY
      // selected comment item must not let this one's diff show highlighted
      // before its own first →.
      state.commentAnchorEntered = false
      // "As if the code were already fully expanded" for a comment anchored
      // to a real block — see openCommentAnchorDrill's own doc comment.
      // Reviewer request: this opens automatically while walking ↑/↓ through
      // the index (visible without an extra step), but WITHOUT moving the
      // keyboard/focus into it — no comment card gets auto-expanded, only an
      // explicit ArrowRight (onKeydown) hands the keyboard in.
      openCommentAnchorDrill(b)
      visitedCommentSinceOrdinary = true
      return
    }
    // Landed on anything other than a comment/comment_group item (an
    // ordinary block or a test_class row) — close a comment-anchor drill left
    // open from the PREVIOUS selection, if any.
    closeCommentAnchorDrillIfOwned()
    if (!b) return // state.blocks hasn't loaded yet — nothing to compare
    const ref = b.kind === 'test_class' ? b.id : `${b.file}:${b.line}`
    if (lastSelectedBlockRef !== undefined && (ref !== lastSelectedBlockRef || visitedCommentSinceOrdinary)) leaveRelated()
    visitedCommentSinceOrdinary = false
    lastSelectedBlockRef = ref
  },
)

// Keep drillRef/drillGran/drillChange/drillCursorRef mirroring
// state.drill/drillCursor — see their own comments on `state` above.
// drillGran/drillChange still only mirror the LAST entry (the focused, deepest
// column — always drillCursor[drillCursor.length - 1], since focusLevel always
// equals drill.length whenever drilling is active), kept for the existing
// round-trip consumers (overviewExitUrl/overview.mjs); drillCursorRef mirrors
// EVERY entry so an ancestor's own cursor also survives a refresh. Every
// entry's id feeds the drillRef path.
watch(
  () => [state.drill, state.drillCursor],
  () => {
    state.drillRef = state.drill.map((b) => b.id).join('>')
    const last = state.drillCursor[state.drillCursor.length - 1]
    state.drillGran = last ? last.gran : 'group'
    state.drillChange = last ? last.change : 0
    state.drillCursorRef = state.drillCursor.map((c) => `${c.gran}:${c.change}`).join('>')
  },
)

// applyBlockRefRestore resolves the `?sel=file:line` restored at load time
// into a real state.selected index, once state.blocks is populated (called at
// the end of loadBlocks — the same "resolve after the data push" pattern as
// RelatedPanel's applyRelRestore). Not found (stale/shared link, or the block
// got filtered out) → leave whatever recomputeLeftList already clamped
// state.selected to. A restored `?sel=comment:<id>` (see commentBlockItem) is
// delegated to applyCommentRefRestore instead — comment items are populated
// by RelatedPanel's own comment poll, independent of loadBlocks, so
// blockRefPending is deliberately left set for a retry there rather than
// given up on after this one attempt.
function applyBlockRefRestore() {
  if (blockRefPending == null) return
  const ref = blockRefPending
  if (ref.startsWith('comment:')) {
    applyCommentRefRestore()
    return
  }
  if (ref.startsWith('testclass:')) {
    applyTestClassRefRestore()
    return
  }
  blockRefPending = null
  const idx = state.blocks.findIndex((b) => b.kind !== 'comment' && b.kind !== 'test_class' && `${b.file}:${b.line}` === ref)
  if (idx >= 0) state.selected = idx
}

// applyTestClassRefRestore resolves a `?sel=testclass:<file>::<class>`
// restored at load time (see testClassRowItem/recomputeLeftList) — the class
// row itself is a normal, synchronously-available part of state.blocks (no
// separate async load, unlike a comment item), so unlike applyCommentRefRestore
// this never needs a retry: not found (stale/shared link) simply leaves
// blockRefPending set, mirroring applyBlockRefRestore's own not-found
// fallback, and gives up silently. Once the class row is found, also
// resolves testMethodRefPending (`?tmethod=file:line`) into
// state.classMethodSel — not found/absent → defaults to the first method (0).
function applyTestClassRefRestore() {
  const idx = state.blocks.findIndex((b) => b.kind === 'test_class' && b.id === blockRefPending)
  if (idx < 0) return
  state.selected = idx
  blockRefPending = null
  const row = state.blocks[idx]
  const mIdx = testMethodRefPending
    ? row.methods.findIndex((m) => `${m.file}:${m.line}` === testMethodRefPending)
    : -1
  state.classMethodSel = mIdx >= 0 ? mIdx : 0
  testMethodRefPending = null
  // `?tcol=1` — the reviewer really had the methodes-kolom focused when this
  // URL was written, so give it the keyboard back (↑/↓ walk the methods
  // immediately, no `→` first). Absent → stays false and the pr-index keeps
  // ↑/↓, exactly like any other restored selection. See the bindUrlState entry
  // for why this can't be derived from `?tmethod=`.
  if (testColumnPending) state.testColumnFocused = true
  testColumnPending = null
}

// applyCommentRefRestore resolves a `?sel=comment:<id>` restored at load time
// into a real state.selected index — a PR-wide comment turned into a
// synthetic "Start" row (see commentBlockItem/recomputeLeftList). Unlike an
// ordinary block, comment items only exist once RelatedPanel's own comment
// poll (syncComments) has landed, which runs independently of loadBlocks and
// may well not have completed yet the first time this runs (from
// applyBlockRefRestore). So this is called again — safely, it's a no-op once
// resolved — from the watch on indexComments() below, every time the
// comment list changes, until the target is actually found or blockRefPending
// gets cleared some other way. Not found (yet, or ever — a deleted/expired
// link) simply leaves blockRefPending pending, mirroring
// applyBlockRefRestore's own not-found fallback, except this one keeps
// retrying instead of giving up after one attempt (since "not there yet" and
// "never there" look identical from here). A stray restored `?mode=diff`
// must not leave the app in diff mode with a comment selected — comment
// items have no diff (see enterDiff's own guard) — mirrors
// applyDefaultUnapprovedSelection's identical guard. Reveals the selection if
// it lands on an already-resolved (thus hidden-by-default) comment
// (revealSelectedIfHidden, generic over isFullyApproved/blockApproveCount's
// comment branch), deferred a couple of microtask turns so the
// approvalSummaries watch (which depends on state.blocks) has flushed first —
// the same wait loadBlocks itself already relies on elsewhere.
function applyCommentRefRestore() {
  if (blockRefPending == null || !blockRefPending.startsWith('comment:')) return
  const idx = state.blocks.findIndex((b) => b.kind === 'comment' && b.id === blockRefPending)
  if (idx < 0) return
  state.selected = idx
  state.mode = 'list'
  blockRefPending = null
  Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => revealSelectedIfHidden())
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
//
// Walks the whole path FIRST, at every level's default {group, 0} cursor
// (drillIntoChild's own fresh push), before applying any restored cursor —
// only afterwards does a second pass apply each level's own
// drillCursorRefPending entry (applyDrillCursorRestoreAt). This order matters:
// relatedChildren(parent) — used to resolve the NEXT path segment — hides a
// relation child while its parent's OWN cursor sits at 'line'/'call'
// granularity (the `scoped` guard, see relatedChildren's own comment above).
// Applying an ancestor's restored (possibly non-'group') cursor DURING the
// walk would make that same ancestor's own next-child lookup fail — a level
// deep enough to have a `line`/`call` cursor restored is, by construction,
// also the parent the walk needs relatedChildren for on the very next
// iteration.
function applyDrillRefRestore() {
  if (!drillRefPending) return
  const path = drillRefPending
  drillRefPending = null
  if (state.mode !== 'diff') {
    drillCursorPending = null
    drillCursorRefPending = null
    return
  }
  let parent = curBlock()
  for (const targetId of path) {
    if (!parent) break
    const match = relatedChildren(parent).find((c) => (c.blockId || c.id) === targetId)
    if (!match) break
    drillIntoChild(match)
    parent = state.drill[state.drill.length - 1]
    // Apply THIS level's own restored cursor right away if it's a 'group'
    // cursor — needed before the NEXT iteration resolves `parent`'s own
    // children: resolvedCallChildren's call-scoping (callScopeMethods) filters
    // a call child down to whichever change group is CURRENTLY active,
    // regardless of granularity, using drillIntoChild's own fresh
    // {change:0, gran:'group'} push — so a target child that only appears
    // inside a LATER restored group (group:N, N>0) can never be found by the
    // next relatedChildren(parent) lookup while that default group:0 cursor
    // is still in effect. A restored 'line'/'call' cursor is deliberately NOT
    // applied here (see this function's own doc comment above): that would
    // flip THIS level's own relatedChildren into the hide-everything 'scoped'
    // branch before the next path segment can be found under it.
    const lvl = state.drill.length
    const entry = drillCursorRefPending && drillCursorRefPending[lvl - 1]
    if (entry && entry.gran === 'group') applyDrillCursorRestoreAt(lvl, parent)
  }
  state.drill.forEach((b, idx) => applyDrillCursorRestoreAt(idx + 1, b))
  // The deepest level also still honours the legacy `?dgran=`/`?dchg=` pair
  // (drillCursorPending) for an older shared link that predates `?dcur=` and
  // so never had drillCursorRefPending populated in the first place — once
  // dcur IS present it already covers the deepest level too, so this is a
  // pure no-op then (drillCursorRefPending truthy → skip).
  if (!drillCursorRefPending && state.drill.length) applyDrillCursorRestore(state.drill[state.drill.length - 1])
  else if (!state.drill.length) drillCursorPending = null
}

// applyDrillCursorRestore re-applies the URL-restored {gran, change} cursor
// (drillCursorPending) onto the deepest drilled column `b` — the legacy,
// deepest-only path kept for an older `?dgran=`/`?dchg=` shared link with no
// `?dcur=` (see applyDrillRefRestore above). One-shot, and a no-op once
// already applied (drillCursorPending is nulled on success) or while `b`'s
// rows aren't known yet: a synthetic call-frame's code is ready synchronously
// (drillIntoChild builds it inline), but a real PR block's code may still be
// an in-flight /api/code fetch — in that case this simply no-ops here and is
// called again from ensureCode's own "drilled column's code arrived" branch
// once b.code lands.
function applyDrillCursorRestore(b) {
  if (!drillCursorPending || !b) return
  if (!b.synthetic && !b.code) return
  const { gran, change } = drillCursorPending
  drillCursorPending = null
  const level = state.focusLevel
  if (level < 1 || state.drill[level - 1] !== b) return
  applyCursorAt(level, b, gran, change)
}

// applyDrillCursorRestoreAt applies drillCursorRefPending's entry for `level`
// (1-based, matching state.focusLevel's own numbering) onto the drilled column
// `b` at that level — one-shot per level: the entry is consumed (nulled in
// place) once applied, and a no-op while `b`'s rows aren't known yet (see
// applyDrillCursorRestore's own comment on that race). Unlike the legacy
// deepest-only path this runs for EVERY level, ancestor or focused, which is
// exactly the point — see state.drillCursorRef's own comment. Retried from
// ensureCode's "drilled column's code arrived" branch (generalized below to
// any drilled level, not just the focused one) once a not-yet-loaded level's
// code lands.
function applyDrillCursorRestoreAt(level, b) {
  if (!drillCursorRefPending || !b) return
  const entry = drillCursorRefPending[level - 1]
  if (!entry) return
  if (!b.synthetic && !b.code) return
  if (state.drill[level - 1] !== b) return
  drillCursorRefPending[level - 1] = null
  applyCursorAt(level, b, entry.gran, entry.change)
}

// applyCursorAt is the shared clamp+assign step behind both restore paths
// above: clamps `change` into the restored gran's actual unit count (mirroring
// ensureCode's own top-level change/gran clamp) and writes it onto
// state.drillCursor[level - 1] without touching that entry's other fields
// (e.g. a live rangeAnchor).
function applyCursorAt(level, b, gran, change) {
  const units = navUnitsOf(b, blockRows(b), gran)
  state.drillCursor = state.drillCursor.map((c, i) =>
    i === level - 1 ? { ...c, gran, change: units.length ? Math.min(Math.max(change, 0), units.length - 1) : 0 } : c,
  )
}

// overviewExitUrl — used by the ← handler in onKeydown (stop 1 of the nav
// chain, state.showDescription) to exit to /pr-overview. Carries `sel`
// alongside `pr` so /pr-overview can hand the same block
// reference back when the reviewer returns to this PR (see the
// originPr/originSel round-trip in overview.mjs, and the "?pr=<id> auto-
// selecteert…" section in .claude/docs/pages-and-routing.md). Only appended
// when there's a current selection to remember — a block-less PR (still
// loading) shouldn't force an empty `sel=` onto the URL.
// `drill`/`dgran`/`dchg`/`dcur` piggyback on the same round-trip, only when
// there's an actual drilled column to remember — see treeUrl's origin*
// counterpart in overview.mjs.
// Also carries `mode=diff` in that case: a drill path only has meaning inside
// a diff session (applyDrillRefRestore requires it), and without it the
// returned-to page would restore in list mode and the app's own URL-mirror
// watch would immediately strip drill/dgran/dchg back out again.
function overviewExitUrl() {
  // The overview keys its rows by (repo, number) — prUid there — so hand back
  // that same identity, not a bare number.
  let url = '/pr-overview?pr=' + encodeURIComponent(prUidHere())
  if (state.blockRef) {
    url += '&sel=' + encodeURIComponent(state.blockRef)
    if (state.drillRef) {
      url += '&mode=diff'
      url += '&drill=' + encodeURIComponent(state.drillRef)
      url += '&dgran=' + encodeURIComponent(state.drillGran)
      url += '&dchg=' + encodeURIComponent(String(state.drillChange))
      url += '&dcur=' + encodeURIComponent(state.drillCursorRef)
    }
  }
  return url
}

// overviewExitUrlAfterApprove — used ONLY by "Goedkeuren en ga naar overzicht"
// below. Deliberately NOT overviewExitUrl(): that helper carries
// `pr`/`sel`/`drill` so /pr-overview selects and remembers the exact block the
// reviewer leaves from — correct for the plain ← exit, wrong here. Once the
// WHOLE PR is approved there's nothing left to return to, and the reviewer
// asked for the opposite: the just-approved PR already gone from the list by
// the time the page appears, with the top remaining row selected instead of
// this one. See `approvedPr`/`trySelectTopAfterApprove` in overview.mjs.
function overviewExitUrlAfterApprove() {
  return '/pr-overview?approved=' + encodeURIComponent(prUidHere())
}

// translationNavUnits adapts translationRowUnits(b) (Block.mjs) — one entry
// per changed/added/removed KEY, each carrying the blockRows row index it
// maps onto — into the generic { start, end } row-range shape every other
// navigation unit (changeGroups/changeLines/changeCalls) already has. Both
// start and end are the same single row (a key is always exactly one
// navigable step, see the granularity note on navUnitsOf below), so a
// TRANSLATION block's per-key units slot into EVERY existing consumer of
// that shape (activeGroup highlighting, unitLineRange's comment/GitHub
// anchoring, approveTargetRows, stepBlock/nextChange/prevChange, the
// postApprove "next unapproved" walk, ...) without those consumers needing
// their own TRANSLATION branch.
function translationNavUnits(b) {
  // `idx` (the unit's own index into translationRowUnits(b)) rides along
  // next to the generic { start, end } shape every consumer already reads —
  // it's needed because `row` alone is NOT a reliable way back to "which
  // key is this": an added key directly adjacent to a removed one lands on
  // the SAME aligned row (alignRows pairs a del+ins pair into one row,
  // exactly like it would for an ordinary code block), so two DIFFERENT
  // translation units can share one `row`. translationSlot's activeIndex
  // (Block.mjs) reads `idx` directly instead of re-deriving the unit from
  // its row, which a shared row would make ambiguous.
  return translationRowUnits(b).map((u, idx) => ({ start: u.row, end: u.row, idx }))
}

// navUnitsOf is the one place that decides whether a block navigates at the
// requested code granularity (group/line/call, unitsFor) or — for a
// TRANSLATION block — per changed KEY instead (translationNavUnits,
// regardless of `gran`: a translation block has no group/line/call
// distinction, see setGran/extendRange's own TRANSLATION guard below, which
// keeps state.gran pinned at 'group' there). Shared by unitsOf/groupsFor
// (navigation + list-mode preview), commentTarget and approveTargetRows so
// per-key navigation, approve-targeting and comment-anchoring all agree on
// the exact same unit list — see .claude/docs/blocks-and-ingest.md
// ("Translation blocks — per-key navigation").
function navUnitsOf(b, rows, gran) {
  if (b && b.category === 'TRANSLATION') return translationNavUnits(b)
  // Reference units — landable but never approvable (declarationReferenceRow's
  // own signature row, and referenceRows' unchanged-but-resolved-call rows) —
  // are TEST-only. Reviewer request: "ik wil alleen navigeren door lines die
  // ik kan goedkeuren, behalve in test bestanden" — outside a TEST-category
  // block ↑/↓/f/d/s (and the Onderliggende-code scoping that rides on the same
  // unit list, see callScopeMethods) only ever stop on a row that is actually
  // approvable; a resolved call hanging off an untouched line in production
  // code becomes unreachable from the diff cursor there (still visible in the
  // panel while ANOTHER unit is in scope, just never scoped to on its own row)
  // — accepted, since that is exactly the declutter being asked for. A TEST
  // block keeps every existing reference-unit behavior unchanged, which is
  // also the scenario both mechanisms were originally built for (a test
  // method calling the very production code it exercises from an untouched
  // line).
  const extra =
    b && b.category === 'TEST'
      ? [...new Set([...declarationReferenceRow(b, rows), ...referenceRows(b, rows)])]
      : NO_REFERENCE_ROWS
  return unitsFor(rows, gran, extra)
}

// declarationReferenceRow returns row 0's index in an array on its own when
// the block is `status === 'added'` (a wholly new function/method) and its
// very first row — the declaration — does NOT itself carry a changed mark,
// e.g. a previously-declared/interface method that only now gets a body: the
// block reads "added" while its signature line is untouched text (identical
// to the interface's), so that row falls outside changeGroups/changeLines
// entirely and neither 'group' nor 'line' granularity can ever land on it —
// the reviewer's first selectable stop is one row too low (the opening `{`).
// Fed into unitsFor's extraRows next to referenceRows below, so it becomes an
// ordinary landable-but-not-approvable "reference" unit (withReferenceUnits,
// Block.mjs) — same semantics as a reference row that carries a resolved
// call, just a different reason for being unchanged. Reviewer request:
// "functie naam is niet selecteerbaar. ik wil dat daar de groep of line kan
// beginnen."
//
// Deliberately scoped to `status === 'added'` only, not every block whose
// declaration happens to be unchanged — an ordinary MODIFIED function almost
// always has an unchanged signature (only its body changed), so widening this
// to every block would add a landable "look only" stop above the real change
// in nearly every reviewed function, which nobody asked for and would derail
// existing "↑ reaches the first real unit" navigation across the whole suite.
//
// Only actually fed into navUnitsOf's extraRows for a TEST-category block —
// see navUnitsOf's own comment.
function declarationReferenceRow(b, rows) {
  return b && b.status === 'added' && rows && rows.length > 0 && !rowChanged(rows[0]) ? [0] : []
}

// referenceRows returns the row indices of b that carry a resolved call into
// underlying code but are NOT changed by this PR — the rows unitsFor turns
// into landable-but-not-approvable "reference" units (see withReferenceUnits
// in Block.mjs). Reviewer request: a test method often calls the very
// production method it exercises from a line the PR never touched, and that
// call site was unreachable — no unit sat on it, so callScopeMethods could
// never scope to it and → could never reach that child.
//
// Only actually fed into navUnitsOf's extraRows for a TEST-category block —
// see navUnitsOf's own comment: outside a TEST block the reviewer only wants
// to walk approvable lines, so this row simply never becomes a stop there
// (the call it carries stays reachable via the panel while some OTHER unit's
// scope covers it, just never scoped to on its own untouched row).
//
// Deliberately ONLY resolved/found method calls (callRows + findCallSites, the
// same pair callScopeMethods scopes by), so a reference unit always has
// something concrete behind it. A block-level synthetic callKey yields no
// sites at all (see isBlockLevelCallKey) and therefore never creates one.
//
// Memoized per block on the identity of its code + the callresolve list, both
// of which are reassigned wholesale rather than mutated: findCallSites runs a
// regex over every row per callKey, and this is reached from navigation
// bindings on every keystroke.
const referenceRowsCache = new WeakMap()
const NO_REFERENCE_ROWS = []
function referenceRows(b, rows) {
  if (!b || !rows || rows.length === 0) return NO_REFERENCE_ROWS
  const resolve = state.callResolve
  const hit = referenceRowsCache.get(b)
  if (hit && hit.code === b.code && hit.resolve === resolve) return hit.rows
  const out = []
  const seen = new Set()
  for (const r of callRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    for (const site of findCallSites(rows, r.callKey)) {
      if (seen.has(site.row)) continue
      const row = rows[site.row]
      if (!row || rowChanged(row)) continue
      seen.add(site.row)
      out.push(site.row)
    }
  }
  out.sort((x, y) => x - y)
  const result = out.length ? out : NO_REFERENCE_ROWS
  referenceRowsCache.set(b, { code: b.code, resolve, rows: result })
  return result
}

// allBlocksById / relationsByParentId / callResolveByCallerId /
// testCoversByTestId memoize four lookups that used to be a fresh linear
// scan on every call: `new Map(state.allBlocks.map((x) => [x.id, x]))` at 9
// separate call sites, and the `.filter(...)` inside callRows/testCoverRows
// plus the inline `for (const r of state.relations) if (r.parentId === …)`
// loop in directChildBlocks. All four are on the hot path of a single Space
// press: directChildBlocks (recursed by nestedChangedKids up to
// NESTED_DEPTH, and by nestedPrBlocks — subtreeApproveCount's helper for the
// approvalSummaries watch, AND commentScopeKeys' for the commentActivity
// watch, both of which call it once per top-level row) and
// findNextUnapproved's tree walk (firstUnapprovedCallSiteInUnit). Measured on
// PR 13255 (166 blocks, ~45 top-level rows): a single Space press landed a
// ~700-800ms main-thread longtask whenever it coincided with the 5s
// comment/chat/workflows poll tick (which is what actually re-triggers the
// commentActivity watch — it depends on commentListSnapshot(), not
// state.codeVersion). A CPU profile's call tree traced that longtask through
// commentScopeKeys → nestedPrBlocks (recursive) → directChildBlocks: with ~45
// top-level rows each re-walking their own subtree, directChildBlocks'
// three per-call linear scans (the id Map build, callRows' filter, and the
// relations loop) each ran hundreds of times per single watch trigger.
// Fixing only the id-Map build (the first attempt here) barely moved the
// profile — the filter/loop scans dominate just as much. All four caches
// share the same reference-identity shape as referenceRowsCache just above
// and blockRowsCache (Block.mjs): state.allBlocks/state.relations/
// state.callResolve/state.testCovers are always wholesale-reassigned, never
// mutated in place (grep confirms exactly one assignment site each, plus one
// `= [...x]` refresh for allBlocks), so comparing the stored array reference
// is a correct, exact invalidation check.
let allBlocksByIdCache = { src: null, map: null }
function allBlocksById() {
  const src = state.allBlocks
  if (allBlocksByIdCache.src !== src) {
    allBlocksByIdCache = { src, map: new Map(src.map((x) => [x.id, x])) }
  }
  return allBlocksByIdCache.map
}

function groupBy(arr, keyFn) {
  const map = new Map()
  for (const item of arr) {
    const key = keyFn(item)
    const list = map.get(key)
    if (list) list.push(item)
    else map.set(key, [item])
  }
  return map
}

let relationsByParentIdCache = { src: null, map: null }
function relationsByParentId() {
  const src = state.relations || []
  if (relationsByParentIdCache.src !== src) {
    relationsByParentIdCache = { src, map: groupBy(src, (r) => r.parentId) }
  }
  return relationsByParentIdCache.map
}

let callResolveByCallerIdCache = { src: null, map: null }
function callResolveByCallerId() {
  const src = state.callResolve || []
  if (callResolveByCallerIdCache.src !== src) {
    callResolveByCallerIdCache = { src, map: groupBy(src, (r) => r.callerId) }
  }
  return callResolveByCallerIdCache.map
}

let testCoversByTestIdCache = { src: null, map: null }
function testCoversByTestId() {
  const src = state.testCovers || []
  if (testCoversByTestIdCache.src !== src) {
    testCoversByTestIdCache = { src, map: groupBy(src, (r) => r.testId) }
  }
  return testCoversByTestIdCache.map
}

const NO_ROWS = []

// groupsFor returns the group-granularity change runs of a block (empty until its
// code has loaded). Used for the list-mode preview, which always previews the
// first *group* regardless of the diff-mode granularity.
function groupsFor(b) {
  return b ? navUnitsOf(b, blockRows(b), 'group') : []
}

// unitsOf returns the navigation units of a block at the *current* granularity
// (empty until its code has loaded). This is what all diff-mode navigation walks.
function unitsOf(b) {
  return b ? navUnitsOf(b, blockRows(b), state.gran) : []
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
// ever meaningful for gran==='line'/'group' (see isRangeGran — the only
// granularities extendRange/drillExtendRange set an anchor at): both a line
// unit and a group unit already carry a { start, end } row range, so merging
// two of them (possibly with an unchanged gap in between, for two separate
// groups) is just a min/max of the two row pairs either way.
function rangeUnit(units, change, anchor) {
  const cur = units[change]
  if (!cur) return null
  if (anchor == null || anchor === change) return cur
  const anchorUnit = units[anchor]
  if (!anchorUnit) return cur
  return { start: Math.min(cur.start, anchorUnit.start), end: Math.max(cur.end, anchorUnit.end) }
}

// isRangeGran reports whether Shift+arrow multi-unit selection is supported at
// this granularity — 'group' and 'line' (not 'call': a row there can hold
// multiple call segments, where "merge two units" has no clear meaning).
function isRangeGran(gran) {
  return gran === 'group' || gran === 'line'
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
  const b = curBlock()
  // A TRANSLATION block navigates per changed KEY only (see navUnitsOf) —
  // there is no group/line/call distinction to zoom through, so f/d/s are a
  // deliberate no-op here (see .claude/docs/blocks-and-ingest.md,
  // "Translation blocks — per-key navigation").
  if (b && b.category === 'TRANSLATION') return
  const rows = blockRows(b)
  const from = GRANS.indexOf(state.gran)
  const cur = navUnitsOf(b, rows, state.gran)[state.change]
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
  const units = navUnitsOf(b, rows, state.gran)
  state.change = units.length ? unitAtRow(units, anchorRow) : 0
  scrollChangeIntoView()
}

// extendRange starts (if not already active) or moves a Shift+ArrowDown/
// ArrowUp multi-unit selection of the top-level cursor by `delta` units. Only
// meaningful at gran==='line' or gran==='group' (see isRangeGran); clamps at
// the block's own first/last unit — unlike nextChange/prevChange a range
// never flows into a same-file neighbour, since approve/comment act on rows
// of a single block.
function extendRange(delta) {
  if (state.mode !== 'diff' || !isRangeGran(state.gran)) return
  const b = curBlock()
  // Per-key navigation is deliberately single-key only (see setGran above) —
  // a TRANSLATION block never gets a Shift+arrow multi-key range either.
  if (b && b.category === 'TRANSLATION') return
  const units = unitsOf(b)
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
  if (next < 0 || next >= state.blocks.length) return false
  const cur = state.blocks[state.selected]
  const nb = state.blocks[next]
  // A synthetic comment-index item (kind:'comment') has no `.file` at all —
  // without this guard two adjacent comment items would coincidentally match
  // on `undefined === undefined`. Neither side of a same-file step may be one.
  // A test_class row (see testClassRowItem/recomputeLeftList) is excluded the
  // same way, on purpose: two test classes in the same file deliberately get
  // NO connector/flow-through between each other at this top level (the
  // method-to-method flow now lives inside the class's own methods column —
  // see stepTestMethod/stepTestMethodChange below, a separate mechanism).
  if (cur.kind === 'comment' || nb.kind === 'comment' || cur.kind === 'test_class' || nb.kind === 'test_class')
    return false
  return nb.file === cur.file
}

// pendingLast records that we stepped *up* into a block whose code hasn't loaded
// yet, so we want to land on its last change group once its rows are known.
// ensureCode resolves it after the fetch. Kept outside reactive state.
let pendingLast = false

// pendingFirstUnapproved is enterDiff's mirror image of pendingLast: we stepped
// INTO a block whose code hasn't loaded yet, so "land on the first unapproved
// unit" (see enterDiff) can't be resolved here — ensureCode applies it once the
// rows are known. Kept outside reactive state, like pendingLast.
let pendingFirstUnapproved = false

// firstUnapprovedChange returns the group-granularity unit index enterDiff
// should land on: the first unit of `b` that still has unapproved changed rows,
// or 0 ("anders gewoon de eerste regel") when everything is approved or the
// block has no units at all. Reuses firstUnapprovedOwnUnit, the exact same walk
// findNextUnapproved's step 1 uses, so "the next open line" means the same
// thing however the reviewer gets there.
function firstUnapprovedChange(b) {
  if (!b) return 0
  const at = firstUnapprovedOwnUnit(b, 'group', -1)
  return at == null ? 0 : at
}

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
  clearBlockDescFocus()
  clearRangeAnchor(0)
  // Flowing on to another block supersedes enterDiff's still-pending
  // "land on the first unapproved unit" landing (its code may only arrive
  // after this step) — this step's own landing wins.
  pendingFirstUnapproved = false
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

// stepTestMethod moves state.classMethodSel by `delta` within the SELECTED
// test_class row's own methods (see testClassRowItem/recomputeLeftList). Once
// it runs past the last/first method of this class, it flows on to the
// first/last method of the next/previous test_class row anywhere further
// down/up state.blocks — decision: "doorlopen mag" INSIDE THE DIFF, the
// class-scoped mirror of stepBlock's own same-file flow-through above
// (deliberately a SEPARATE mechanism — see sameFileNeighbour's own guard).
// Returns false at the very end of the list (no further class row in that
// direction) — mirrors stepBlock's own false-at-the-edges contract.
// Only used by stepTestMethodChange (diff mode) now: the LIST-mode
// methodes-kolom deliberately does NOT flow across class rows anymore — at
// the class edges its ↑/↓ exit back to the index and step exactly one row
// (see onKeydown's isTestColumnActive() branch), on explicit request:
// index navigation is per row/class, never per method.
function stepTestMethod(delta) {
  const row = curTestClassRow()
  if (!row) return false
  const next = state.classMethodSel + delta
  if (next >= 0 && next < row.methods.length) {
    state.classMethodSel = next
    return true
  }
  const dir = delta > 0 ? 1 : -1
  let idx = state.selected + dir
  while (idx >= 0 && idx < state.blocks.length && state.blocks[idx].kind !== 'test_class') idx += dir
  if (idx < 0 || idx >= state.blocks.length) return false
  const target = state.blocks[idx]
  state.selected = idx
  state.classMethodSel = dir > 0 ? 0 : target.methods.length - 1
  return true
}

// stepTestMethodChange is stepTestMethod's diff-mode counterpart, mirroring
// stepBlock exactly (change-group reset, pendingLast deferral, scrolling) but
// for moving to a neighbouring test method instead of a neighbouring
// top-level block.
function stepTestMethodChange(delta) {
  if (!stepTestMethod(delta)) return false
  clearRangeAnchor(0)
  // See stepBlock: this step's landing supersedes a pending enterDiff one.
  pendingFirstUnapproved = false
  const groups = unitsOf(curBlock())
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
// off the end / start of this one (see stepBlock) — or, while a test_class row
// is selected, into the neighbouring test method (see stepTestMethodChange).
// Shared by the ↓/↑ arrows and by f/d on the 'call' level, so both walk the
// diff the same way.
function nextChange() {
  const groups = unitsOf(curBlock())
  if (state.change >= groups.length - 1) {
    if (curTestClassRow()) stepTestMethodChange(1)
    else stepBlock(1)
  } else {
    clearBlockDescFocus()
    clearRangeAnchor(0)
    state.change = state.change + 1
    scrollChangeIntoView()
  }
}

function prevChange() {
  if (state.change <= 0) {
    if (curTestClassRow()) stepTestMethodChange(-1)
    else stepBlock(-1)
  } else {
    clearBlockDescFocus()
    clearRangeAnchor(0)
    state.change = state.change - 1
    scrollChangeIntoView()
  }
}

// ---------------------------------------------------------------------------
// The block-description stop (see state.descFocusId's own comment above)
// ---------------------------------------------------------------------------

// blockDescStopAvailable — does the block the keyboard is on have a description
// strip to step onto at all? Only at the top level (focusLevel === 0): a
// drilled Onderliggende-code column keeps its own {change, gran} cursor with no
// description stop of its own (deliberate scope limit, see
// .claude/docs/keyboard-navigation.md).
function blockDescStopAvailable() {
  if (state.mode !== 'diff' || state.focusLevel > 0) return false
  const b = curBlock()
  return !!(b && b.description)
}

// blockDescFocused — does the description strip currently OWN the keyboard? A
// stale id (the reviewer navigated to another block without a clear running)
// never counts, because it is re-resolved against the block the cursor is on.
function blockDescFocused() {
  const b = curBlock()
  return !!(state.descFocusId && b && b.id === state.descFocusId && blockDescStopAvailable())
}

// clearBlockDescFocus releases the strip, called from every path that moves the
// diff cursor or the block selection by itself (stepBlock/nextChange/prevChange/
// enterDiff/leaveDiffToList/selectRow/the mouse entry point) — the same
// discipline clearRangeAnchor/clearListAnchor already follow one level up.
function clearBlockDescFocus() {
  if (state.descFocusId) state.descFocusId = ''
}

// blockDescExpanded / toggleBlockDescExpanded — is this block's strip opened out
// past its 2-line cap, and the toggle BOTH Enter on the focused strip and a
// click on it run (same function for key and mouse, see
// .claude/docs/mouse-navigation.md). A click also lands the cursor on the strip,
// exactly like toggleSinceExpanded/toggleDescriptionExpanded do at stop 1.
// Reassigns the array instead of mutating it, so the reactive bindings reading
// it re-run.
function blockDescExpanded(b) {
  return !!b && state.descExpanded.includes(b.id)
}

function toggleBlockDescExpanded({ focus = false } = {}) {
  const b = curBlock()
  if (!b || !b.description) return
  if (focus) state.descFocusId = b.id
  if (!blockDescCollapsible(b)) return
  state.descExpanded = blockDescExpanded(b)
    ? state.descExpanded.filter((id) => id !== b.id)
    : [...state.descExpanded, b.id]
}

// focusBlockDesc / leaveBlockDesc — the ↑ onto the strip from the block's first
// change, and the ↓ back off it onto that same first change.
function focusBlockDesc() {
  const b = curBlock()
  if (!b) return false
  state.descFocusId = b.id
  scrollBlockDescIntoView()
  return true
}

function leaveBlockDesc() {
  clearBlockDescFocus()
  state.change = 0
  scrollChangeIntoView()
}

// scrollBlockDescIntoView keeps the strip in view when the cursor lands on it —
// vertical axis only (scrollIntoViewVertical), never a bare scrollIntoView: the
// card sits inside <main>'s horizontally scrolling column flow, see the axis
// rule in .claude/rules/arrowjs-pitfalls.md.
function scrollBlockDescIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid="block-description-strip"][data-desc-focused="true"]')
    if (el) scrollIntoViewVertical(el)
  })
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
  const res = await fetch(`/api/blocks?pr=${state.pr}${repoQuery}`)
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
  // hadSelParam reuses the top-level hadInitialSelParam snapshot (whether this
  // load is restoring a real `?sel=file:line`/`?sel=comment:<id>` — a refresh/
  // shared link/the /pr-overview round trip — or a genuinely fresh open, e.g.
  // "Open review tree" without a remembered position) rather than
  // re-reading `blockRefPending != null` here: a `?sel=comment:<id>` restore
  // can already have resolved (and nulled blockRefPending) by this point if
  // RelatedPanel's comment poll happened to land before this /api/blocks
  // fetch did — reading it fresh here would then wrongly read as "no sel
  // param" and let the new default-unapproved-selection treatment below
  // override the just-restored selection. Only a genuinely fresh open gets
  // that treatment; a restored sel keeps going through the existing
  // reveal/pin path untouched.
  const hadSelParam = hadInitialSelParam
  // A genuinely fresh open (no ?sel= at all — a bare /pr/<id> link, "Open
  // review tree"/"Generate" from the PR overview without a remembered
  // position, a freshly generated PR) lands on stop 1 (the PR-description
  // column) instead of the block-index default-unapproved pick below: the
  // reviewer's first view of a PR they haven't navigated in yet should be the
  // summary, not a block. Set eagerly (before the approvals/blockstats await
  // below) so it takes effect immediately, not once loading finishes. A
  // restored `sel` (hadSelParam true) never touches this — it keeps landing
  // straight on the restored block, as before. → still unconditionally steps
  // from stop 1 into the block-index regardless of load state (see
  // onKeydown's showDescription branch), so this doesn't newly depend on the
  // tree having finished loading.
  if (!hadSelParam) state.showDescription = true
  applyBlockRefRestore()
  // pristineSelectedId/pristineToggleFocused snapshot the selection right
  // after the synchronous load steps above, so applyDefaultUnapprovedSelection
  // below — which only runs after the approvals/blockstats round trip — can
  // detect whether the reviewer (or any other mechanism) has already moved
  // the selection away in the meantime. Without this guard it would
  // unconditionally overwrite whatever the reviewer just clicked/navigated to
  // while the fetch was still in flight, silently reverting a real
  // interaction — unlike revealSelectedIfHidden, which is self-correcting (a
  // no-op unless the CURRENT selection is hidden), applyDefaultUnapprovedSelection
  // always picks a target, so it needs this explicit check instead.
  // Deliberately an ID snapshot, not the raw index: the indexComments()
  // watch (recomputeLeftList, see below) can insert new comment
  // items and reindex the SAME still-selected block to a different index in
  // the meantime — that's not the reviewer moving the selection, just
  // recomputeLeftList's own id-preserving reindex (mirrors its own `selId`
  // logic) — an index-only comparison here would treat that reindex as "the
  // reviewer already moved on" and skip the default pick entirely, even
  // when a comment item legitimately deserves that pick once it exists.
  const pristineSelectedId = state.blocks[state.selected] ? state.blocks[state.selected].id : null
  const pristineToggleFocused = state.toggleFocused
  const callResolvePromise = loadCallResolve()
  const testCoversPromise = loadTestCovers()
  loadExplanations()
  // Hidden-ness (a fully-approved block while state.showApproved is false) only
  // becomes knowable once BOTH the approvals and the server-side totals are in
  // — isFullyApproved reads state.approvalSummaries, which the decoupled
  // approval-rollup watch recomputes from exactly those inputs. Await them,
  // give arrow.js a couple of microtask turns to flush that watch (the same
  // openTask precedent as selectComment's scope wait), then either reveal a
  // restored selection that landed on a hidden block (?sel=) or, on a fresh
  // open with no sel at all — and only if nothing already moved the selection
  // in the meantime — land on the first not-yet-approved item instead
  // (applyDefaultUnapprovedSelection) — see its own doc comment below.
  // The test run's volatile snapshot rides along on the same PR (one read +
  // the SSE push, no poll of its own — see testRun.mjs), same shape as
  // syncCommentBatch's own call site (RelatedPanel.mjs's syncComments).
  syncTestRun(state.pr)
  await Promise.all([loadApprovals(), loadBlockStats(), loadIgnoredComments(), ensureAutoWarn()])
  // state.blockTotals only lands here (loadBlockStats), after the FIRST
  // recomputeLeftList() call above already ran without it — re-run so a
  // childIds row with a confirmed zero total drops out of the index (see the
  // comment in recomputeLeftList itself). Preserves selection by id, like
  // every other recomputeLeftList() call.
  recomputeLeftList()
  await Promise.resolve()
  await Promise.resolve()
  const curSelectedId = state.blocks[state.selected] ? state.blocks[state.selected].id : null
  if (hadSelParam) revealSelectedIfHidden()
  else if (curSelectedId === pristineSelectedId && state.toggleFocused === pristineToggleFocused) {
    // A comment item that hasn't arrived yet (see freshDefaultSelectionAt's
    // own comment) can still win this pick later, once the independent
    // comment poll lands — retryDefaultSelectionForComments below picks up
    // from here.
    freshDefaultSelectionPending = true
    applyDefaultUnapprovedSelection()
  }
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
    const res = await fetch(`/api/blockstats?pr=${state.pr}${repoQuery}`)
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
      body: JSON.stringify({ pr: state.pr, repo: state.repo || undefined }),
    })
    if (res.ok) {
      const { runId } = await res.json()
      if (runId) state.approveRunId = runId
    }
  } catch (_) {
    /* offline — approval stays session-only */
  }
  try {
    const res = await fetch(`/api/approvals?pr=${state.pr}${repoQuery}`)
    if (!res.ok) return
    const rows = await res.json()
    if (!Array.isArray(rows)) return
    const byId = allBlocksById()
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

// loadIgnoredComments ensures the per-PR `ignore_comment` tracker is running
// (its Run ID is what every Ignore toggle signals to) and restores which
// PR-comment index items are hidden, from the read-model into
// state.ignoredComments. Both steps are best-effort — offline, ignoreRunId
// stays empty and ignoring stays session-only (the behaviour this feature
// replaced). Mirrors loadApprovals exactly, including living outside every
// render binding: it's called from loadBlocks, so the wholesale reassign below
// can never race a watch that rewrites the same state (see the co-subscriber
// pitfall in .claude/rules/conventions.md).
//
// The stored ids are raw comment ids; the 'comment:' prefix is the frontend's
// own index-item id shape (commentBlockItem), so it is added here rather than
// stored in the read-model.
async function loadIgnoredComments() {
  try {
    const res = await fetch('/api/workflows/ignore_comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr, repo: state.repo || undefined }),
    })
    if (res.ok) {
      const { runId } = await res.json()
      if (runId) state.ignoreRunId = runId
    }
  } catch (_) {
    /* offline — ignoring stays session-only */
  }
  try {
    const res = await fetch(`/api/commentignores?pr=${state.pr}${repoQuery}`)
    if (!res.ok) return
    const data = await res.json()
    if (!data || !Array.isArray(data.ignored)) return
    const next = {}
    for (const id of data.ignored) next['comment:' + id] = true
    state.ignoredComments = next
  } catch (_) {
    /* offline — keep whatever we have */
  }
}

// persistIgnoredComment signals one comment's ignored state to the durable
// ignore_comment tracker — the ONLY write path (the UI never writes a
// read-model directly). A no-op until ignoreRunId is known (offline);
// fire-and-forget, best-effort, mirroring persistApproval.
function persistIgnoredComment(commentId, ignored) {
  if (!commentId || !state.ignoreRunId) return
  fetch(`/api/workflows/${state.ignoreRunId}/signals/ignore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commentId, ignored }),
  }).catch(() => {})
}

// approvalAnchors describes, in the block's CURRENT aligned rows, every row the
// approval covers — the approved rows plus the rows its call keys sit on — as
// { row, text, prev, next }. A row index on its own means nothing once the PR
// gets new commits, so this is what lets the backend find the same code back
// afterwards instead of re-applying a stale index (see reanchor.go, and
// "Durable persistence" in .claude/docs/approval.md). The neighbours are what
// tell a repeated line (a bare `}`, a mirrored array literal) from its twins.
//
// Returns null — NOT an empty array — when the block has no rows to describe
// (its code isn't loaded), which the backend reads as "leave the stored anchors
// alone" rather than "clear them".
function approvalAnchors(b) {
  const rows = blockRows(b)
  if (!rows.length) return null
  const want = new Set(b.approvedRows || [])
  for (const key of b.approvedCalls || []) {
    const row = Number(String(key).split(':')[0])
    if (Number.isInteger(row)) want.add(row)
  }
  return [...want]
    .filter((r) => r >= 0 && r < rows.length)
    .sort((x, y) => x - y)
    .map((r) => ({
      row: r,
      text: rowAnchorText(rows[r]),
      prev: r > 0 ? rowAnchorText(rows[r - 1]) : '',
      next: r < rows.length - 1 ? rowAnchorText(rows[r + 1]) : '',
    }))
}

// persistApproval signals a block's full approved state to the durable approve
// tracker — the ONLY write path (the UI never writes a read-model directly). A
// no-op until approveRunId is known (offline); fire-and-forget, best-effort.
function persistApproval(b) {
  if (!b || !state.approveRunId) return
  const anchors = approvalAnchors(b)
  fetch(`/api/workflows/${state.approveRunId}/signals/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blockId: b.id,
      rows: b.approvedRows || [],
      calls: b.approvedCalls || [],
      ...(anchors ? { anchors } : {}),
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

// wasFullyApproved — module scope, not on `state`, same reasoning as
// viewedFiles: it only guards the ONE-TIME transition below, never rendered.
// See notifyFullyApprovedIfNeeded.
let wasFullyApproved = false

// notifyFullyApprovedIfNeeded fires ONLY on the transition into "every
// changed row/call in the whole tree is approved" (state.approvalTotal,
// filled right above by the approvalSummaries watch) — mirrors
// syncViewedFiles' own "only on transitions" shape. Tells the durable
// `approve` tracker to stamp prmeta's FullyApprovedAt (see
// combineSinceMoment, inbox.go): on your OWN PR, GitHub never sees a review
// FROM you, so this in-app "I've read every line" moment is what makes
// "nieuw sinds jouw review" correct there too (PPTD-948). Fire-and-forget,
// same write path as persistApproval/signalFileViewed — the UI only ever
// signals the tracker, never writes a read-model directly.
function notifyFullyApprovedIfNeeded() {
  const isFullyApproved =
    state.approvalTotal.total > 0 && state.approvalTotal.done === state.approvalTotal.total
  if (isFullyApproved && !wasFullyApproved && state.approveRunId) {
    fetch(`/api/workflows/${state.approveRunId}/signals/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullyApproved: true }),
    }).catch(() => {
      /* best-effort */
    })
  }
  wasFullyApproved = isFullyApproved
}

// recomputeLeftList derives state.blocks from allBlocks: everything except the
// PR blocks that are the definition of a resolved method call (already shown
// in the "Onderliggende code" panel). A called-and-shown function shouldn't
// also sit in the left list; those targets often live in files the PR didn't
// change (pure reference code shown for context). Relation children, however,
// DO stay in the list — sorted to the bottom under an "Onderliggende code"
// heading (state.underlyingIds), so they remain fully navigable index rows
// while still also appearing as children in the panel. Test coverage is
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
// recomputeLeftList's rank() no longer groups by category at all (that fixed
// ROUTE/CONTROLLER Laravel-hierarchy priority was dropped in favor of
// fileRank/fileUnderlyingCount, see recomputeLeftList) — it groups by FILE
// instead, for the same reason a category grouping used to give it for free:
// sameFileNeighbour/stepBlock (the same-file connector hint + ↑/↓
// block-to-block flow, see keyboard-navigation.md) only look at the
// immediate index neighbour, so splitting one file's blocks apart would
// silently break that navigation.

// commentBlockItem turns a comment that belongs in the index (see
// RelatedPanel.mjs's indexComments — the PR-wide ones: issue/review/
// review_summary comments plus code_warning's ai_warning findings and orphans,
// PLUS a block-anchored comment that @-mentions me) into a synthetic, navigable
// state.blocks item: kind:'comment' marks it (guarded everywhere something
// assumes a real PR block — see enterDiff/ensureCode/sameFileNeighbour/
// blockApproveCount/the DetailPanel pair.forEach branch), a stable id
// ('comment:'+c.id, never colliding with a real block id's 'pr:file:label'
// shape) so selection survives a recompute, and `comment` carries the raw
// data back for the detail card / action menu. `label` is a short, one-line
// snippet of the body (falls back to the kind label for an empty body) so
// the sidebar row reads sensibly; `category` is a dedicated pseudo-category
// (BlockList.mjs's CATEGORY_STYLE.COMMENT) so it gets its own pill colour
// instead of falling into OTHER. `status` stays '' — there's no
// added/modified/removed concept for a comment, so the status pill/mark
// simply shows nothing (statusInfo's fallback).

// freshDefaultSelectionPending/freshDefaultSelectionAt back the retry of
// applyDefaultUnapprovedSelection's fresh-open pick once the PR-wide comment
// list arrives (see that function's own doc comment, and
// retryDefaultSelectionForComments below) — declared here, ahead of the
// indexComments() watch a little further down, which calls
// retryDefaultSelectionForComments() from its own callback the moment it's
// registered (arrow.js runs a fresh watch's callback once, synchronously):
// a `let` declared after that point would still be in its temporal dead
// zone at that first, synchronous call.
let freshDefaultSelectionPending = false
let freshDefaultSelectionAt = null // { blockId } | { toggle: true } | null

// commentAnchorBlock resolves a comment's own file+label back to the real PR
// block it's anchored to, if any — the same identity `anchoredBlocks`
// (recomputeLeftList) already checks to decide whether the comment even gets
// its own index row. Purely a lookup: never mutates state.selected/mode/
// drill. Searches state.allBlocks (the flat, complete /api/blocks list,
// see loadBlocks) rather than state.blocks (the derived, grouped/filtered
// DISPLAY list — test methods folded into their test_class row, resolved-
// call/relation children pulled into "Onderliggende code", approved rows
// possibly hidden) — a comment must resolve to its anchor regardless of
// how the sidebar currently happens to be grouped/filtered, and every real
// block (including a TEST method) is present in state.allBlocks either way.
// Returns null for a comment with no matching block at all (a genuinely
// PR-wide issue/review/review_summary comment, an unanchored "ai_warning"
// finding, or an orphan whose block is gone).
function commentAnchorBlock(c) {
  if (!c || !c.file) return null
  return state.allBlocks.find((b) => b.file === c.file && b.label === c.label) || null
}

// openCommentAnchorDrill makes selecting a PR-comment index item that IS
// anchored to a real block (commentAnchorBlock) show "as if the code were
// already fully expanded" — the explicit request behind this function: the
// comment's own block opens as a drilled column (state.drill[0]), exactly
// like Enter on an Onderliggende-code child would (drillIntoChild), but
// WITHOUT ever leaving list mode. That one difference is what keeps the
// blokken-index visible (BlockList.mjs only hides it in diff mode) while
// state.selected stays put on the comment row itself (so the sidebar
// highlight never jumps to the block) — a comment item can never itself be
// drilled deeper (see the DetailPanel pair.forEach kind==='comment' branch),
// so this is always exactly one level, state.drill[0].
//
// Called from the state.selected watch above on every comment-item
// selection (click or arrow key), so it opens automatically while merely
// walking ↑/↓ through the index — reviewer request: "als ik door blokken
// index langs ga, wil ik dat het al uitgeklapt is". Deliberately does NOT
// move the keyboard/cs.focus into it, though: no comment card ever gets
// auto-expanded/auto-focused by this call alone (see the watch's own
// `leaveRelated()` right before it) — only an explicit ArrowRight
// (onKeydown, below) hands the keyboard IN, mirroring the ordinary
// state.mode==='diff' ArrowRight flow. "Uitgeklapt, maar niet direct
// geselecteerd."
//
// commentTarget()/commentScope()/relatedChildren() all key off focusedBlock(),
// which at focusLevel>0 resolves to this drilled entry — so the comment
// thread (now correctly scoped, since an anchored comment's own Kind is ''
// per anchoredWarning in code_warning.go — it passes recomputeView's
// `!c.kind` filter like any ordinary block comment), the Onderliggende-code
// panel and the embedded Claude column all follow along for free, with no
// further wiring needed. This is also what makes the drilled column fully
// KEYBOARD-navigable (reviewer request) despite state.mode staying 'list':
// relatedActive()'s ↑/↓/←/→ handling in onKeydown is unconditional on mode,
// so once ArrowRight calls enterCommentsOrRelated() (mirroring the ordinary
// state.mode==='diff' ArrowRight branch), the existing generic
// comment/thread/Claude-column walk takes over exactly as it would for any
// other block — no separate mechanism was needed.
//
// `b` is the comment-index ITEM (kind:'comment', see commentBlockItem) —
// possibly standing for a GROUP of several comments on the same line
// (commentGroupKeyOf). The drilled cursor is set to the group's own shared
// unit, from its PRIMARY comment `b.comment` (comments[0] — every comment in
// the group shares the same file+label+line by construction, so any member
// resolves to the same anchor/cursor). Once open, `commentScope`'s ordinary
// row-range filtering (commentUnder) shows every comment that actually falls
// under that cursor unit — not just the ones in this synthetic sidebar
// group — exactly as it already does for any other block's inline comments,
// so no separate "show the whole group" wiring is needed here either.
// The drilled cursor is set to the comment's OWN unit (c.gran/c.rowStart),
// not drillIntoChild's plain {change:0, gran:'group'} default — commentScope
// (via focusedBlock()) filters the "in-block" comment index down to whatever
// unit the cursor sits on, and the whole point here is that the very comment
// that opened this view shows up in it (mirrors openTask's identical
// unitAtRow lookup).
function commentAnchorCursor(anchor, c) {
  const gran = c.gran || 'group'
  const rows = blockRows(anchor)
  const units = rows.length ? navUnitsOf(anchor, rows, gran) : []
  const change = units.length ? unitAtRow(units, c.rowStart != null && c.rowStart >= 0 ? c.rowStart : 0) : 0
  return { change, gran }
}

function openCommentAnchorDrill(b) {
  const c = b.comment
  const anchor = commentAnchorBlock(c)
  if (!anchor) {
    closeCommentAnchorDrillIfOwned()
    return
  }
  // sameComment — this exact comment-index ROW was already the one that
  // opened the current drill, snapshotted BEFORE commentAnchorDrillFor is
  // overwritten below. Deliberately not the same check as
  // `state.drill[0] === anchor`: commentAnchorBlock resolves purely by
  // file+label, so TWO DIFFERENT rows (two ai_warning findings on separate
  // lines of the same function, say) resolve to the identical anchor
  // object. Bug report: stepping from one "Comments op regels" row to a
  // second row anchored to the same block kept showing the FIRST finding's
  // thread on the right — `state.drillCursor` (which commentTarget()/
  // commentUnder scope the visible comment down to) never moved to the
  // second comment's own line, because the guard below used to fire on the
  // shared anchor alone and skip the recompute.
  const sameComment = commentAnchorDrillFor === b.id
  commentAnchorDrillFor = b.id
  // Already open on this exact SAME row (e.g. the comment-poll's 5s tick
  // reassigning cs.list, which can retrigger the state.selected watch — see
  // lastFiredSelectionRef above) — leave it alone so a granularity/viewMode
  // change the reviewer just made inside it survives. A different row that
  // happens to share the same anchor block must still move the cursor (see
  // sameComment above).
  if (sameComment && state.drill.length === 1 && state.drill[0] === anchor) return
  // Reviewer request: a comment-op-regel/chat-op-regel anchor should default
  // to 'fit' ("Alleen nieuwe code, breedte volgt de code") — mirrors the
  // existing allChangesAreSingleLine/allChangesAreAdditionsOnly auto-jump in
  // diff-card.md: an INITIAL stand only, via the shared state.diffViewMode
  // (no private field, see "No private diff stand" below), not a permanent
  // override — the reviewer can still cycle away with `a`/the indicator and
  // it sticks for as long as this exact row stays selected (the sameComment
  // guard above already skips this line on every retrigger of the SAME row,
  // e.g. the comment-poll's 5s tick). Landing on a genuinely different row
  // (or this row again after navigating away) re-applies 'fit'. applyDiffViewMode
  // itself is a no-op when 'fit' is already active.
  applyDiffViewMode('fit')
  state.drill = [anchor]
  state.drillCursor = [commentAnchorCursor(anchor, c)]
  state.focusLevel = 1
  scrollFocusIntoView()
  // The thread auto-expands (isAnchorOnlyComment, RelatedPanel.mjs) but never
  // gets the keyboard, so it never goes through toComment()'s own
  // scroll-to-bottom — without this it silently kept its DOM-default
  // scrollTop (the TOP of the thread) instead of showing the newest reply.
  // Reported bug: resolving a comment and landing on the next one showed the
  // top of a long thread instead of the bottom. Deliberately not called from
  // the `sameComment` early-return above — an idempotent poll retrigger on
  // the SAME row must not yank a manual scroll-up back down.
  primeAnchorThreadScroll()
  // commentAnchorCursor's row lookup needs the anchor's own aligned diff rows
  // (blockRows), which aren't there yet on this block's very first open — it
  // silently fell back to {change:0}. Recompute once the code (and thus the
  // real rows) has actually landed, but only if this exact drill is still
  // the one open (a fast ↓/↑ away from this comment before the fetch settles
  // must not resurrect/overwrite whatever is open by then).
  if (!anchor.code) {
    ensureCode(anchor).then(() => {
      if (state.drill.length === 1 && state.drill[0] === anchor && state.focusLevel === 1) {
        state.drillCursor = [commentAnchorCursor(anchor, c)]
      }
    })
  }
}

// isCommentAnchorDrillActive reports whether the drilled column at `level`
// is exactly the one openCommentAnchorDrill opened for the CURRENTLY
// selected comment item — as opposed to an ordinary Onderliggende-code drill
// (Enter on a related child), which must keep following the shared
// state.diffViewMode. Only level 1 can ever be a comment anchor (see
// openCommentAnchorDrill), and only while curBlock() is still that same
// comment item — stepping the selection away already closes the drill (see
// the state.selected watch above), but this stays level-scoped rather than
// stack-length-scoped so drilling further IN from the anchor (a second,
// ordinary child) still correctly identifies which single level is the
// special one.
//
// Checked against `commentAnchorDrillFor` — the plain bookkeeping var
// openCommentAnchorDrill/closeCommentAnchorDrillIfOwned already keep in sync
// with "which item currently owns the ONE open drilled column" — rather than
// re-deriving the anchor via a fresh `commentAnchorBlock(b.comment) ===
// state.drill[0]` object-identity comparison on every call. The two SHOULD
// always agree, but re-deriving on every read repeats a `state.allBlocks.find`
// lookup and compares by reference — exactly the "snapshot by stable ID, not
// identity" trap conventions.md warns about — for no benefit, since
// commentAnchorDrillFor is already the authoritative, one-time-computed
// answer.
function isCommentAnchorDrillActive(level) {
  if (level !== 1) return false
  const b = curBlock()
  return !!(b && b.kind === 'comment' && commentAnchorDrillFor === b.id)
}

// commentAnchorOnlyIds — the comment id(s) a "Comments op regels" index item
// stands for (b.comments, the whole line-group — see "Comment-index rows are
// grouped per source line" in comments-panel.md; falls back to the single
// b.comment for a synthetic item with no group array). Feeds
// commentScope's onlyIds above, so RelatedPanel narrows the visible thread(s)
// down to exactly this row's own comment(s), not every comment commentUnder
// would otherwise surface on the same unit. Only ever called while
// isCommentAnchorDrillActive(1) is true, i.e. curBlock() is genuinely the
// comment-index item that opened this drill.
function commentAnchorOnlyIds() {
  const b = curBlock()
  const list = (b && (b.comments || (b.comment ? [b.comment] : []))) || []
  return list.map((c) => c.id)
}

// commentAnchorColumnHidden reports whether the top-level block-column must
// disappear ENTIRELY rather than collapse to its usual narrow rail. While an
// anchored comment-index item's own drilled column owns the keyboard (see
// openCommentAnchorDrill), that rail was the one visible difference between
// this view and having navigated to the very same block through the code: the
// anchor's diff card sat one rail (plus one of <main>'s gap-4 gaps) to the
// right of where an ordinary block card starts. Reviewer request: "als je een
// comment op regel selecteert, [wil ik] hetzelfde zien als dat je via de code
// hebt genavigeerd" — so the drilled anchor becomes the leading column and the
// layout matches ordinary code navigation exactly (blokken-index, diff card,
// Onderliggende code, comments).
//
// Gated on focusLevel > 0: stepping the keyboard back OUT of the drilled
// column (←) must still show the comment's own commentDetailCard here, never
// an empty column.
function commentAnchorColumnHidden() {
  return state.focusLevel > 0 && isCommentAnchorDrillActive(1)
}

// commentAnchorAwaitingEntry — an anchored comment-index item's column is open
// (openCommentAnchorDrill) but the reviewer is still walking the blokken-index
// with ↑/↓ and hasn't handed the keyboard in with `→` yet. Reviewer request:
// "als ik navigeer door comments op regels dan wil ik niet dat er 2 dingen
// geselecteerd zijn, dus selecteer alleen items in blokken index totdat ik
// naar rechts druk" — so until that `→`, the column shows the code with NO
// active unit highlighted at all; the sidebar row is the only thing that
// reads as selected. The cursor itself (state.drillCursor) is untouched: it
// still points at the comment's own line, ready for the moment the reviewer
// steps in, and commentScope keeps filtering the thread by it.
//
// Follow-up reviewer request: "als ik 1 keer naar rechts ga, selecteer code,
// als ik 2 keer naar rechts ga selecteer dan eerste openstaande comment" — a
// single → used to both un-suppress this highlight AND jump straight into the
// comments in one step (enterCommentsOrRelated, see the ArrowRight branch in
// onKeydown), which is exactly why the diff briefly read as "entered" and
// "not entered" at once depending on timing. `state.commentAnchorEntered` is
// now the one authoritative bit for "has the first → already happened" — set
// by that same ArrowRight branch, independent of relatedActive() (which only
// becomes true on the SECOND →, once enterCommentsOrRelated actually moves
// the keyboard into the comment/thread).
function commentAnchorAwaitingEntry(level) {
  return isCommentAnchorDrillActive(level) && !relatedActive() && !state.commentAnchorEntered
}

// Keep state.indexHandedOff in sync — deps enumerated inline in the getter per
// the watch rule in .claude/rules/arrowjs-pitfalls.md. See its own comment on
// `state` for why BlockList reads a mirrored field instead of calling
// relatedActive() itself.
//
// Deliberately NARROWER than a bare relatedActive(): only an anchored
// comment-index item's own column counts. Every other way of handing the
// keyboard right either hides the index (diff mode) or is a bulk action run
// FROM a still-standing index selection — e.g. "Comment op deze N regels"
// opens the composer (relatedActive() true) while the Shift+arrow range must
// visibly stay selected, see tests/list-range-select.spec.mjs.
watch(
  () => [relatedActive(), state.selected, state.blocks, state.drill],
  () => {
    const handedOff = relatedActive() && isCommentAnchorDrillActive(1)
    state.indexHandedOff = handedOff
    // A MOUSE click straight into that column (a comment card, the Claude
    // column, an Onderliggende-code chip) never passes through onKeydown's
    // ArrowRight branch, so it used to leave state.commentAnchorEntered
    // false: no active-row highlight, no blue card border, and (since that
    // same flag now collapses the pr-index, see BlockList.mjs) an index
    // still standing where the keyboard path slides it away. Catching up
    // here rather than at each click site keeps the mouse rule of
    // .claude/docs/mouse-navigation.md — a click does what a key does — with
    // one watch instead of per-handler wiring. Guarded on the current value
    // so this writes only on the real transition: the vendored proxy
    // notifies on every assignment, unchanged value or not (see
    // .claude/rules/arrowjs-pitfalls.md).
    if (handedOff && !state.commentAnchorEntered) state.commentAnchorEntered = true
  },
)

// Scroll the comment/composer/Claude-chat/Onderliggende-code column fully
// into view when the reviewer steps the keyboard/mouse into it, and restore
// the diff to its own flush-left rest position on the way back out — one
// watch on the transition covers every entry point (keyboard `→`, clicking
// a comment icon, "Nieuwe comment", a comment-index row's auto-drill, ...)
// instead of patching each call site individually. `scrollFocusIntoView()` on
// the false-transition duplicates the existing manual call in onKeydown's own
// ArrowLeft/Escape branch (harmless: same rAF-scheduled scroll to the same
// place). Deps enumerated inline per the watch rule in
// .claude/rules/arrowjs-pitfalls.md; relatedActive() is a single
// unconditional read of RelatedPanel's own cs.focus, same pattern the
// indexHandedOff watch above already relies on.
//
// `state.codeVersion` is ALSO listed as a dep: a fresh page load restoring
// ?rel.foc=... from the URL can own the keyboard before the selected block's
// own (lazily-loaded) diff has finished rendering, so <main> may not overflow
// yet — or may only reach its FINAL width over several code-load steps — at
// the moment relatedActive() itself first becomes true. codeVersion bumps
// every time any block's code arrives (see the codeVersion doc comment on
// `state` above), so re-running scrollRelatedIntoView() on every bump while
// still active keeps re-measuring against <main>'s real, settling width
// instead of only getting one shot at a possibly-too-early layout. Harmless
// while inactive: the false-branch just re-calls scrollFocusIntoView(), the
// same idempotent rest-position scroll.
watch(
  () => [relatedActive(), state.codeVersion],
  ([active]) => {
    if (active) scrollRelatedIntoView()
    else scrollFocusIntoView()
  },
)

// commentBlockItem now takes a GROUP of one or more comments that all sit on
// the exact same source line (see commentGroupKeyOf/recomputeLeftList —
// reviewer request: "comments in de blokken index moeten gegroepeerd worden
// per line"). `comments[0]` stays the item's own PRIMARY comment: every
// existing single-comment mechanism (selectedComment/prCommentCommandsFor's
// Beantwoorden/Resolve/Chat/Ignore, the → thread-walk for an UNANCHORED item)
// keeps reading `b.comment` unchanged and simply acts on the first comment of
// the line — only blockApproveCount looks at the full `comments` array (to sum
// done/total across the whole group). A solo comment (the overwhelmingly
// common case) is a "group" of exactly one, so nothing about its own row
// changes. Space's own batch-checkbox toggle (spaceKey) deliberately stays
// scoped to just `b.comment` (the primary), mirroring batchCheckbox's own
// scope — see "The comment_batch checkboxes and the bottom action row" in
// comments-panel.md.
function commentBlockItem(comments) {
  const c = comments[0]
  // The generated short title (comment_titles, see commentTitleOf in
  // RelatedPanel.mjs) when there is a fresh one — it says in 6 words what the
  // 60-character body snippet below could only start to say. Falls back to that
  // snippet for a comment that has (or needs) no title.
  // A bare Claude-chat anchor's OWN body is always the fixed
  // CLAUDE_ANCHOR_PLACEHOLDER sentence — once the reviewer's own first reply
  // has taken it over (firstReviewerReplyOnPlaceholder), that reply IS the
  // real comment text and the label must read it, not the placeholder. See
  // "A taken-over Claude-chat anchor reads as an ordinary comment" in
  // comments-panel.md.
  const takenOverReply = firstReviewerReplyOnPlaceholder(c)
  const snippet =
    commentTitleOf(c) ||
    ((takenOverReply ? takenOverReply.body : c.body) || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  // An orphan is a block comment that lost its block (a commit renamed/removed
  // the symbol — see reanchor.go): it gets a row here instead of vanishing, and
  // its fallback label names the block it USED to hang on, so the reviewer can
  // still tell what it was about when the body itself is empty.
  const fallback = isOrphanComment(c)
    ? c.label || t('Verdwenen code')
    : c.kind === 'ai_warning'
      ? t('AI-risico')
      : // A block-anchored (kind === '') comment only gets an index item when it
        // mentions me (see indexComments); with an empty body, naming the block
        // it hangs on says far more than the generic "PR-comment" would.
        (!c.kind && c.label) || t('PR-comment')
  const base = snippet || fallback
  const extra = comments.length - 1
  return {
    id: 'comment:' + c.id,
    kind: 'comment',
    // "· +N" for a group of more than one — the row otherwise reads exactly
    // like a single comment's, so the reviewer can still tell several
    // threads hang on this one line.
    label: extra > 0 ? `${base} · +${extra}` : base,
    category: 'COMMENT',
    status: '',
    // mentioned — this comment OR ANY OTHER ONE IN THE GROUP (or one of
    // their replies) @-mentions the local reviewer, which sorts the whole
    // row above every other comment item (rank -2 in recomputeLeftList)
    // under its own "Mentioned" heading (BlockList.mjs). Computed here, once
    // per recompute, so neither the sort nor the heading has to re-scan
    // bodies.
    mentioned: comments.some(commentMentionsMe),
    // lineAnchored — this item hangs on a real source line (a genuinely
    // block-anchored, non-orphan comment) rather than being PR-wide/orphan
    // feedback with no "regel" of its own. Computed once here (from the
    // group's primary comment — commentGroupKeyOf only ever groups comments
    // that already share this, see its own doc comment) so recomputeLeftList's
    // rank() and BlockList.mjs's heading logic don't have to re-derive it.
    // Drives where the row sorts (see rank below): "onder de aangepaste
    // bestanden" under its own "Comments op regels" heading, including a
    // MENTIONED one — a PR-wide/orphan mention (no regel at all) is the only
    // kind that still ranks at the very top, under "Mentioned".
    lineAnchored: !c.kind && !isOrphanComment(c),
    comment: c,
    comments,
  }
}

// chatBlockItem — the "Openstaande chats" index row (see openChatComments,
// RelatedPanel.mjs): a comment with an existing Claude conversation that
// otherwise has no row of its own (already resolved, or a bare "Chat over
// deze regel" anchor with no written comment at all). Reuses
// commentBlockItem's own label/mentioned computation (a single-comment
// "group" of one) rather than duplicating it, then marks the result
// `chatOnly` — the one flag that routes it into its own rank band/heading
// (recomputeLeftList/BlockList.mjs) and makes a second ArrowRight land
// straight in the chat instead of the comment thread (home.mjs's onKeydown,
// see comments-panel.md/claude-chat-panel.md).
function chatBlockItem(c) {
  const item = commentBlockItem([c])
  item.id = 'chat:' + c.id
  item.category = 'CHAT'
  item.chatOnly = true
  // A general chat has no comment text to name it by — its anchor body is
  // only ever CLAUDE_ANCHOR_PLACEHOLDER (see isGeneralChatAnchor) — so it
  // says what it is instead of showing that placeholder sentence.
  if (isGeneralChatAnchor(c)) {
    item.label = t('Algemene chat')
    item.generalChat = true
  }
  return item
}

// testClassRowItem turns every TEST-category block of one file+class into a
// single, synthetic state.blocks item (see "Grouping test methods per class"
// in .claude/docs/detail-layout.md): kind:'test_class' marks it (guarded
// everywhere something assumes a real PR block, mirroring kind:'comment' —
// see enterDiff/ensureCode/sameFileNeighbour/blockApproveCount/openTask/the
// DetailPanel pair.forEach branch). `methods` keeps every real PR block that
// belongs to this class, in ingest order — curBlock() resolves through
// state.classMethodSel into this array, so every existing block-centric
// mechanism keeps working on whichever method is active without knowing
// about test classes at all. Grouped on `file + '::' + class` (not bare class
// name) so two same-named classes in different files never merge — a real,
// if rare, possibility. `label` is the bare class name (never `class + '::'
// + method`, like a model_usage child — see blockLabel in Block.mjs); a
// whole-file scanner-fallback block (unparseable file, Class === '') falls
// back to the file's own basename so the row never shows an empty label.
function testClassRowItem(file, className, methods) {
  const label = className || file.split('/').pop()
  return {
    id: 'testclass:' + file + '::' + className,
    kind: 'test_class',
    label,
    class: className,
    file,
    category: 'TEST',
    status: '',
    methods,
  }
}

// groupTestClasses partitions `blocks` into ordinary (non-TEST) entries and
// one testClassRowItem per distinct file+class among the TEST-category ones —
// always grouped, even for a class with a single changed method (decision:
// a predictable flow, no exception for the common "just one method changed"
// case). Every group keeps its methods in the ORIGINAL relative order (stable
// partition, mirrors fileRank's own stable-sort reasoning) so the
// existing same-file adjacency assumptions elsewhere are unaffected by this
// step — grouping happens before the rank sort below, not instead of it.
function groupTestClasses(blocks) {
  const rest = []
  const groups = new Map() // "file::class" -> methods[]
  for (const b of blocks) {
    if (b.category !== 'TEST') {
      rest.push(b)
      continue
    }
    const key = b.file + '::' + (b.class || '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(b)
  }
  const rows = [...groups.entries()].map(([key, methods]) => {
    const file = methods[0].file
    const className = methods[0].class || ''
    return testClassRowItem(file, className, methods)
  })
  return [...rest, ...rows]
}

// searchHaystack is the lowercased text one sidebar row is matched against by
// the "Zoek startpunten…" box: its label, its category and its file path —
// plus, for a test_class row (which stands in for several methods, see
// groupTestClasses), the same three of every method it groups. Kept as its own
// function so the two branches can't drift apart.
function searchHaystack(b) {
  const own = [b.label, b.category, b.file].filter(Boolean).join(' ')
  if (b.kind !== 'test_class' || !Array.isArray(b.methods)) return own.toLowerCase()
  const methods = b.methods.map((m) => [m.label, m.category, m.file].filter(Boolean).join(' ')).join(' ')
  return (own + ' ' + methods).toLowerCase()
}

// commentGroupKeyOf USED TO group a comment-index candidate (see
// recomputeLeftList) with every OTHER comment anchored to the exact same
// source line, so a line carrying several open threads got ONE index row
// instead of N ("comments... gegroepeerd worden per line"). That grouping is
// DELIBERATELY REVERTED (2026-08-27): a reviewer opening a group row that
// happened to combine a human review comment with an anchored AI-controle
// finding (`code_warning`, which drops to `kind === ''` once it resolves to a
// real line — see `anchoredWarning` in `code_warning.go`) saw BOTH cards on
// the right for a SINGLE left-hand selection, which broke the harder
// invariant: "what I select on the left must be exactly what I see on the
// right, nothing else from the same block/selection" — see "Comments op
// regels shows only its own comment" below, whose `onlyIds` narrowing this
// grouping fed with more than one id. Rather than special-case the AI/human
// mix, the reviewer chose to drop grouping altogether, even for two purely
// human comments on the same line: every comment gets its OWN index row
// again. **Always returns null on purpose** — do not reintroduce a grouping
// key here; if line-clutter becomes a problem again, solve it without
// merging distinct comments into one selectable unit. The rest of the
// group machinery (`comments`/`onlyIds`/"· +N" in `commentBlockItem`) is
// left in place, unused for now beyond a group-of-one, since it still is the
// generic mechanism `commentAnchorOnlyIds` etc. rely on — see
// "Comment-index rows: grouping reverted" in comments-panel.md.
function commentGroupKeyOf(c, anchoredBlocks) {
  return null
}

function recomputeLeftList() {
  // Only the resolved-call targets are hidden from the index (panel-only
  // reference code). Relation children STAY in state.blocks — fully navigable
  // rows (own diff, selection, ?sel= restore for free) — but sort to the very
  // bottom, under the "Onderliggende code" heading (state.underlyingIds →
  // BlockList.mjs). A relation child that is ALSO a resolved call target keeps
  // following the hidden set (it already shows in the panel as a resolved
  // call). A resolved call TARGET whose CALLER is a TEST block (a test
  // literally calling the production method it exercises) is exempt from the
  // hidden set the same way a testCoverTargetIds() target is exempt — see
  // resolvedCallTargetIds/testCallTargetIds — so it joins the relation
  // children here instead of vanishing.
  const hidden = new Set(resolvedCallTargetIds())
  const testTargetIds = testCallTargetIds()
  const childIds = new Set([...state.relations.map((r) => r.childId), ...testTargetIds])
  const selId = state.blocks[state.selected] && state.blocks[state.selected].id
  const q = (state.search || '').trim().toLowerCase()
  // A comment item that hangs on a real source line (b.lineAnchored, see
  // commentBlockItem) sorts UNDER the changed-files categories (rank 2.5 —
  // above real category ranks, which top out at 2, but below "Onderliggende
  // code"'s rank 3) under its own "Comments op regels" heading (reviewer
  // request: a line-linked comment belongs with the code it's about, not
  // above every changed file). This includes a MENTIONED line-anchored
  // comment — someone waiting on an answer still gets that row, just inside
  // this section rather than at the very top.
  //
  // A comment with NO regel at all (PR-wide/orphan — b.kind unset here means
  // b.comment.kind/isOrphanComment, not this synthetic item's own `kind`) is
  // still not tied to any particular block, but sorts UNDER every real
  // category (rank 2.4 — reviewer request: "gooi algemene pr comments net
  // boven Comments op regels", i.e. right above the line-anchored section
  // rather than at the very top) and just above "Comments op regels" (2.5);
  // once resolved it folds into the same "Toon N goedgekeurde blocks" section
  // as a fully-approved block (isFullyApproved/blockApproveCount's
  // comment-item branch below), exactly like any other row. A MENTIONED one
  // among those (still no regel) is the one exception that STAYS at the very
  // top (-2, above every category) under its own "Mentioned" heading —
  // someone is waiting on an answer, so that one must not sit below
  // unrelated feedback; only the ordinary, unmentioned PR-wide section moved.
  //
  // A testCallTargetIds row (a test literally calling the production method
  // it exercises) with a CONFIRMED server-side total of 0 (state.blockTotals,
  // GET /api/blockstats — see "A block with zero changed rows has nothing to
  // approve" in .claude/docs/approval.md) has nothing to approve, so it gets
  // no checkbox on its own card already; giving it its own "Onderliggende
  // code" index row on top of that is a dead entry with nothing to do
  // (reported on PR 13392's DeleteTenantSubscriptionsActivity.php — a genuine,
  // whitespace/trivial-only diff called from a test). Drop it from the index
  // — it stays in state.allBlocks, so the Onderliggende-code panel and
  // drilling into it are unaffected, only the standalone index row goes away.
  // `=== 0` (not falsy/undefined) so "stats not loaded yet" keeps the row
  // visible until the real number is known.
  //
  // Deliberately NOT applied to an ordinary relation child (state.relations):
  // a relation only exists between two blocks that BOTH changed (see
  // "Relations between blocks" in .claude/docs/workflows-analysis.md), so a
  // confirmed-zero relation child should never occur for real ingested data —
  // and also deliberately not applied to an ordinary top-level block with
  // total 0 (see the general "zero changed rows" case in
  // .claude/docs/approval.md), which keeps its own index slot as before.
  const visibleBlocks = state.allBlocks.filter(
    (b) => !hidden.has(b.id) && !(testTargetIds.has(b.id) && state.blockTotals[b.id] === 0),
  )
  // groupedRows is the non-comment half of the list (real blocks + the
  // synthetic test_class rows), already TEST-partitioned-last by
  // groupTestClasses. Computed here, before `rank`, because the "most left
  // to approve" ordering below needs to scan this exact row set.
  const groupedRows = groupTestClasses(visibleBlocks)
  // fileUnderlyingCount/fileOrder/fileRank implement "hoe meer onderliggende
  // blokken, hoe verder naar boven" (reviewer request, replacing the earlier
  // "meeste te approven bovenaan" heuristic AND the fixed ROUTE/CONTROLLER
  // Laravel-hierarchy tiers — the reviewer no longer wants either as the
  // ordering signal). TEST always sorts last regardless of its own count
  // (explicit reviewer instruction), so it doesn't participate in this
  // ranking.
  //
  // Grouped per FILE, not per individual block: sameFileNeighbour/stepBlock
  // (the same-file connector + ↑/↓ block-to-block flow, see
  // keyboard-navigation.md) only look at the immediate index neighbour, so
  // ranking every block individually could split one file's own functions
  // apart whenever they differ in underlying-block count. Summing per file
  // and sorting FILES (blocks within a file keep their existing stable
  // relative order) keeps a file's blocks contiguous, exactly like the old
  // per-category grouping did for the same reason.
  //
  // "Onderliggende blokken" is the full recursive subtree (nestedPrBlocks —
  // the same helper subtreeApproveCount uses for the sidebar pill), not just
  // direct children. A descendant shared by several top-level blocks can
  // therefore be counted more than once across files — accepted here since
  // this only drives a ranking, never a number shown to the reviewer
  // (contrast the old categoryRemaining's own-block-only choice, which
  // existed specifically to avoid inflating a real displayed total, see
  // "Combined approval per tree" in .claude/docs/approval.md — that concern
  // doesn't apply to a ranking).
  const fileUnderlyingCount = {}
  for (const b of groupedRows) {
    if (childIds.has(b.id)) continue // "Onderliggende code" — rank 3, not part of this band
    if (b.category === 'TEST') continue // always sorts last, see fileRank below
    fileUnderlyingCount[b.file] = (fileUnderlyingCount[b.file] || 0) + nestedPrBlocksCached(b).length
  }
  const fileOrder = Object.keys(fileUnderlyingCount).sort((a, b) => fileUnderlyingCount[b] - fileUnderlyingCount[a])
  // fileRank slots an ordinary (non-TEST) file's blocks into a fractional
  // value in (0, 2.3) — safely below the comment ranks (2.4/2.5) and
  // "Onderliggende code" (3): the file with the most underlying blocks gets
  // the lowest fractional value, so the ascending sort below puts it first.
  // TEST gets a fixed 2.39 — still below "Onderliggende code" (3), but always
  // the LAST band, never competing on its own count.
  function fileRank(file) {
    const idx = fileOrder.indexOf(file)
    if (idx < 0) return 2
    return (2.3 * (idx + 1)) / (fileOrder.length + 1)
  }
  const rank = (b) => {
    if (b.kind !== 'comment') {
      if (childIds.has(b.id)) return 3
      if (b.category === 'TEST') return 2.39
      return fileRank(b.file)
    }
    // chatOnly (Openstaande chats, see openChatComments) is checked BEFORE
    // lineAnchored — a chat-only item is always ALSO block-anchored (it
    // needs a real code anchor to drill into, same as a line comment), so
    // lineAnchored is true for it too; without this it would sort into
    // "Comments op regels" instead of its own section. Sits directly under
    // that section (2.55, still below "Onderliggende code" at 3).
    if (b.chatOnly) return 2.55
    if (b.lineAnchored) return 2.5
    return b.mentioned ? -2 : 2.4
  }
  // An UNRESOLVED block-anchored comment gets its own index row (indexComments,
  // RelatedPanel.mjs) — but only when the block it hangs on is actually in this
  // tree. Otherwise the row would be a dead end: selecting it shows the comment,
  // yet there is no code to step into and no block to fall back to (that is
  // exactly what the orphan/PR-wide kinds are for, which keep their row
  // unconditionally, as does a comment that @-mentions me). The check lives here
  // rather than in indexComments because state.blocks is this module's own.
  const anchoredBlocks = new Set(state.allBlocks.map((b) => b.file + '|' + b.label))
  const commentCandidates = indexComments().filter(
    (c) => c.kind || isOrphanComment(c) || commentMentionsMe(c) || anchoredBlocks.has(c.file + '|' + c.label),
  )
  // commentGroupKeyOf always returns null now (grouping was reverted, see its
  // own doc comment) — every candidate falls through to its own unique
  // 'single:'+id key, so this Map always ends up one comment per group. Kept
  // as a Map (rather than a flat map()) so a future re-introduction of real
  // grouping has one place to change; insertion order is still what decides a
  // row's position, same as before.
  const commentGroups = new Map() // key -> comment[]
  for (const c of commentCandidates) {
    const key = commentGroupKeyOf(c, anchoredBlocks) || 'single:' + c.id
    if (!commentGroups.has(key)) commentGroups.set(key, [])
    commentGroups.get(key).push(c)
  }
  const commentItems = [...commentGroups.values()].map(commentBlockItem)
  // "Openstaande chats" (see openChatComments/chatBlockItem above) — only for
  // a comment whose own anchor block is actually in this tree, same
  // dead-end-avoidance reasoning as commentCandidates above (a row with no
  // code to drill into would be a dead end).
  // A general chat (isGeneralChatAnchor — PR-wide, code-less) is exempt from
  // that condition by definition: it has no anchor block, and its row is not
  // a dead end either — it opens the general-chat overlay instead of drilling
  // into code. Same `c.kind ||` carve-out commentCandidates above already
  // makes for a PR-wide comment.
  const chatItems = openChatComments()
    .filter((c) => isGeneralChatAnchor(c) || anchoredBlocks.has(c.file + '|' + c.label))
    .map(chatBlockItem)
  state.blocks = [...groupedRows, ...commentItems, ...chatItems]
    // The haystack is label + category + FILE PATH (reviewer request: "ik wil
    // ook op bestandsnaam kunnen zoeken") — the path is what you remember when
    // you don't recall the method name, and a comment item simply has no
    // `file`, so it keeps matching on its body snippet alone. A test_class row
    // has no label/file of its own worth matching beyond its class name, so it
    // additionally matches on any of its METHODS' label/category/file.
    .filter((b) => !q || searchHaystack(b).includes(q))
    .sort((a, b) => rank(a) - rank(b))
  const underlying = {}
  for (const b of state.blocks) if (childIds.has(b.id)) underlying[b.id] = true
  state.underlyingIds = underlying
  const at = state.blocks.findIndex((b) => b.id === selId)
  // The previously selected id survives a reindex (id-preserving, see
  // conventions.md's "snapshot a selection by stable ID" entry) → keep it.
  // Genuinely GONE (e.g. the selected PR-wide/anchored comment just got
  // resolved elsewhere while the reviewer was deep in a drilled subtree —
  // indexComments drops a resolved block-anchored comment entirely, see its
  // own doc comment) used to fall back to `Math.min(state.selected, …)` —
  // the OLD raw index clamped into the new (shorter) list, landing on
  // whatever now happens to sit at that position. That's an arbitrary
  // leftover position, not a real selection decision, and often scrolled out
  // of view — reviewer report: "ik heb dan niks geselecteerd ... selecteer
  // dan de eerste in de blokken index". Reset to the first row instead,
  // mirroring setSearch's own `state.selected = 0` after a filter change
  // (the other place "the old selection no longer applies" already resets
  // to the top rather than clamping a stale index).
  state.selected = at >= 0 ? at : 0
}

// Re-derive state.blocks whenever the index-comment list changes (initial
// load, a poll picking up a new/imported comment or a reply that mentions me,
// a resolve) — mirrors loadCallResolve's own recomputeLeftList() call after its
// async load. Deliberately the same indexComments() recomputeLeftList itself
// uses (not the narrower prWideComments): a newly arrived block-anchored
// comment that mentions me must trigger a recompute too, or its "Mentioned"
// row would only appear on the next unrelated recompute.
// indexComments() only reads RelatedPanel.mjs's cs.list (a plain filter, no
// b.code involved), so this never risks the "stuck on loading" co-subscriber
// pitfall (see conventions.md) the way reading a block's own code would.
// Also retries a pending `?sel=comment:<id>` restore (applyCommentRefRestore)
// and a still-pending fresh-open default selection
// (retryDefaultSelectionForComments) every time this list updates — comment
// items only exist in state.blocks once this watch has run at least once
// with actual data, which may well be later than loadBlocks' own one-shot
// applyBlockRefRestore/applyDefaultUnapprovedSelection calls.
// chatConversationIds() is listed alongside indexComments() so a fresh
// GET /api/chat?pr=N landing (loadChatConversations reassigning
// cc.conversations) also re-derives "Openstaande chats" (openChatComments,
// chatBlockItem) — not just a comment-list change.
watch(
  () => [indexComments(), chatConversationIds()],
  () => {
    recomputeLeftList()
    applyCommentRefRestore()
    retryDefaultSelectionForComments()
  },
)

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
  return stepVisibleFrom(state.selected, dir)
}

// stepVisibleFrom is stepVisibleSelected's body with an explicit starting index,
// so the same "which index does BlockList actually render a row for" rule can
// answer a second question: which block the look-ahead PREVIEW card should show
// (DetailPanel below). That preview used to read the RAW next index
// (`i === sel + 1`) while every navigation path went through this scan, so a
// hidden row directly after the selection was previewed under the diff even
// though the index listed no such row and ↓ would never land on it — reported
// bug: a resolved, ORPHANED comment about a file that is no longer in the PR at
// all (its row hidden because "resolved == approved", see blockApproveCount's
// comment branch + renderList's showApproved skip) rendered as a full card
// stacked under an unrelated PHP test diff. Returns `from` itself when nothing
// visible remains in that direction, exactly as before.
function stepVisibleFrom(from, dir) {
  const last = state.blocks.length - 1
  let candidate = from
  for (;;) {
    candidate += dir
    if (candidate < 0 || candidate > last) return from
    const b = state.blocks[candidate]
    if (!state.showIgnored && isIgnoredComment(state, b)) continue
    if (state.showApproved || !isFullyApproved(state, b)) return candidate
  }
}

// previewIndexAfter names the state.blocks index the look-ahead preview card
// shows: the next VISIBLE row after `sel` — i.e. exactly where ↓ lands
// (stepVisibleSelected(1)) — or null when `sel` is the last visible row, in
// which case there is nothing to preview. Product decision (explicit): the
// preview stays equal to the ↓ target even when that target is a comment-index
// item, so the card below the diff always means "this is the next stop" rather
// than "the next diff".
function previewIndexAfter(sel) {
  const next = stepVisibleFrom(sel, 1)
  return next === sel ? null : next
}

// lastVisibleIndex is the mirror-image scan of stepVisibleSelected: the last
// state.blocks index BlockList's renderList would actually render a row for
// (same isIgnoredComment/isFullyApproved skip rules), or -1 if nothing is
// visible. Used as the ↑-from-a-toggle-row/search-box landing spot (see
// stepListSelection/searchStepSelection below).
function lastVisibleIndex() {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i]
    if (!state.showIgnored && isIgnoredComment(state, b)) continue
    if (state.showApproved || !isFullyApproved(state, b)) return i
  }
  return -1
}

// firstVisibleIndex is the mirror image of lastVisibleIndex: the first
// state.blocks index BlockList's renderList would actually render a row for,
// or -1 if nothing is visible. Used as the ↓-from-the-search-box landing spot
// (searchStepSelection below) — "eerste blok" in the sidebar's ↑/↓ loop.
function firstVisibleIndex() {
  for (let i = 0; i < state.blocks.length; i++) {
    const b = state.blocks[i]
    if (!state.showIgnored && isIgnoredComment(state, b)) continue
    if (state.showApproved || !isFullyApproved(state, b)) return i
  }
  return -1
}

// toggleRowVisible mirrors BlockList's renderList: the toggle-approved button
// only exists once at least one top-level block is fully approved — regardless
// of whether state.showApproved currently reveals or folds it away.
function toggleRowVisible() {
  return state.blocks.some((b) => isFullyApproved(state, b))
}

// ignoreToggleRowVisible mirrors toggleRowVisible above, for the toggle-ignored
// button ("Toon N verborgen comments") — exists once at least one PR-comment
// index item has been explicitly ignored (see isIgnoredComment), regardless of
// whether state.showIgnored currently reveals or folds them away.
function ignoreToggleRowVisible() {
  return state.blocks.some((b) => isIgnoredComment(state, b))
}

// batchRowVisible mirrors toggleRowVisible/ignoreToggleRowVisible for the
// bottom "Verwerk N comments met Claude" action row — it exists whenever at
// least one comment-index item is batch-eligible (batchEligibleRows,
// BlockList.mjs), regardless of how many of them are currently checked.
function batchRowVisible() {
  return batchEligibleRows(state).length > 0
}

// pushTodoRowVisible mirrors the two above for the push-todo row at the very
// bottom of the index (pushTodoRow in BlockList.mjs) — it exists exactly while
// this PR has landed Claude commits that are not pushed to GitHub yet
// (state.pendingPush, see loadPendingPush). Unlike the toggle rows it is not
// derived from state.blocks at all: it is about the branch, not about a block,
// which is precisely why it is a todo "for the end" rather than a comment on
// some block.
function pushTodoRowVisible() {
  return !!(state.pendingPush && state.pendingPush.ahead > 0)
}

// selectRow sets state.selected to a NEW index chosen by the reviewer
// (sidebar click, ↑/↓, search) — resetting state.classMethodSel/
// testColumnFocused every time, so a stale "which method"/"is the column
// focused" from a PREVIOUSLY selected test_class row never leaks onto
// whatever gets selected next (mirrors the existing composer/reply reset on
// every selection change just above). Deliberately NOT used by
// openTask/applyNextUnapproved/applyTestClassRefRestore, which each set
// classMethodSel/testColumnFocused explicitly to their OWN intended values
// right after moving state.selected — resetting there first would just be
// immediately overwritten, so those keep assigning state.selected directly.
function selectRow(idx) {
  state.selected = idx
  state.classMethodSel = 0
  state.testColumnFocused = false
  // Another block's diff never inherits the previous block's description-strip
  // cursor (see clearBlockDescFocus).
  clearBlockDescFocus()
  // A plain (non-shift) selection change supersedes a Shift+arrow multi-row
  // selection, exactly as clearRangeAnchor does one level down in the diff.
  clearListAnchor()
}

// clearListAnchor drops an active Shift+arrow multi-row selection in the
// sidebar AND in the methodes-kolom. Called from every plain navigation path
// that moves the cursor by itself (selectRow, the search box, stepping into a
// diff) — mirrors clearRangeAnchor's discipline for the diff cursor.
function clearListAnchor() {
  state.listAnchor = null
  state.methodAnchor = null
}

// listRangeIndices returns the state.blocks indices an active sidebar
// multi-selection covers (anchor..cursor, inclusive, in list order), or just
// the cursor's own index when there is no anchor. Skips rows BlockList would
// not render at all (a hidden approved block / a hidden ignored comment): an
// action must never silently touch a row the reviewer can't even see.
function listRangeIndices() {
  const cur = state.selected
  if (state.listAnchor == null) return cur >= 0 && state.blocks[cur] ? [cur] : []
  const lo = Math.min(state.listAnchor, cur)
  const hi = Math.max(state.listAnchor, cur)
  const out = []
  for (let i = lo; i <= hi; i++) {
    const b = state.blocks[i]
    if (!b) continue
    if (!state.showIgnored && isIgnoredComment(state, b)) continue
    if (!state.showApproved && isFullyApproved(state, b) && i !== cur) continue
    out.push(i)
  }
  return out
}

// methodRangeIndices is listRangeIndices' methodes-kolom twin: the indices of
// the selected test_class row's own .methods the Shift+arrow selection covers.
function methodRangeIndices(row) {
  const cur = state.classMethodSel
  if (!row || !Array.isArray(row.methods)) return []
  if (state.methodAnchor == null) return row.methods[cur] ? [cur] : []
  const lo = Math.min(state.methodAnchor, cur)
  const hi = Math.max(state.methodAnchor, cur)
  const out = []
  for (let i = lo; i <= hi; i++) if (row.methods[i]) out.push(i)
  return out
}

// hasMultiSelection reports whether more than one row is currently selected —
// in the sidebar or in the methodes-kolom. Drives both the palette's own
// range-scoped command list and Space's bulk approve.
function hasMultiSelection() {
  if (state.mode !== 'list') return false
  if (isTestColumnActive()) return methodRangeIndices(curTestClassRow()).length > 1
  return state.listAnchor != null && listRangeIndices().length > 1
}

// extendListRange is Shift+ArrowDown/ArrowUp in the block index: it moves the
// cursor exactly like a plain arrow (stepVisibleSelected, so hidden rows are
// skipped) but REMEMBERS where the selection started, so everything between
// stays selected. Deliberately clamps at the first/last visible block instead
// of continuing into the toggle/search stops at the bottom of the loop — those
// are not blocks and can't take part in a multi-row action, the same reasoning
// that makes the diff-level range clamp at the block boundary.
function extendListRange(dir) {
  if (state.mode !== 'list') return
  if (
    state.toggleFocused ||
    state.ignoreToggleFocused ||
    state.batchRowFocused ||
    state.pushTodoFocused ||
    state.searchActive
  )
    return
  const next = stepVisibleSelected(dir)
  if (next === state.selected) return
  if (state.listAnchor == null) state.listAnchor = state.selected
  // Deliberately NOT selectRow: that clears the anchor we just set. The two
  // resets it also does still apply — a range walk changes which row is
  // current, so a stale test-method cursor must not ride along.
  state.selected = next
  state.classMethodSel = 0
  state.testColumnFocused = false
  scrollSelectedIntoView()
}

// extendMethodRange is the same gesture inside the methodes-kolom (stop 2b),
// over the selected test_class row's own methods. Clamps at the class edges —
// unlike a plain ↑/↓ there it never exits into the index, since a selection
// spanning two different rows of the index has no meaning here.
function extendMethodRange(dir) {
  const row = curTestClassRow()
  if (!row || !row.methods.length) return
  const next = state.classMethodSel + dir
  if (next < 0 || next >= row.methods.length) return
  if (state.methodAnchor == null) state.methodAnchor = state.classMethodSel
  state.classMethodSel = next
  scrollSelectedIntoView()
}

// toggleRangeApproval approves — or, when everything in the selection is
// already fully approved, clears — every row of an active Shift+arrow
// multi-selection in one action. The bulk twin of toggleBlockApproval/
// toggleTestClassApproval, and it reuses them rather than reimplementing what
// "approve this row" means per kind:
//   • a test_class row  → toggleTestClassApproval (all of its methods)
//   • an ordinary block → its own changedRows, after ensureCode
//   • a comment item    → skipped: "approved" there means "resolved", which is
//     a real GitHub-side action, never something a bulk key should trigger.
// Each block is persisted individually through the existing single-block
// `approve` Signal (persistApproval) — one Signal per block, never a batch
// write. Same scope decision as the block/class checkbox: no
// afterApproveAction/postApprove follow-up, this is a bulk toggle rather than
// a step in the review flow.
async function toggleRangeApproval() {
  if (isTestColumnActive()) {
    const row = curTestClassRow()
    const methods = methodRangeIndices(row).map((i) => row.methods[i])
    await applyBulkApproval(methods)
    return
  }
  const blocks = listRangeIndices()
    .map((i) => state.blocks[i])
    .filter((b) => b && b.kind !== 'comment')
  const classRows = blocks.filter((b) => b.kind === 'test_class')
  const plain = blocks.filter((b) => b.kind !== 'test_class')
  await applyBulkApproval(plain)
  for (const row of classRows) await toggleTestClassApproval(row)
}

// applyBulkApproval is toggleRangeApproval's per-block half: approve every
// changed row of each block, or clear them all when they are already fully
// approved (so the gesture toggles, like every other approve action).
async function applyBulkApproval(blocks) {
  if (!blocks.length) return
  await Promise.all(blocks.map((b) => ensureCode(b)))
  const allDone = blocks.every((b) => {
    const c = blockApproveCount(b)
    return c.total > 0 && c.done === c.total
  })
  for (const b of blocks) {
    b.approvedRows = allDone ? [] : changedRows(blockRows(b))
    if (!allDone) b.approvedCalls = []
    persistApproval(b)
  }
}

// bulkApprovalTargets is the block set both PR-wide bulk actions below walk:
// state.allBlocks, NOT state.blocks. The left list deliberately HIDES the
// resolved-call targets (recomputeLeftList's `hidden` set) — panel-only
// reference code shown as an "Onderliggende code" card — but those blocks are
// fully approvable units that the approval ROLLUP does count
// (directChildBlocks resolves through allBlocksById, so subtreeApproveCount/
// findNextUnapproved keep landing on them). Walking state.blocks therefore
// left the PR unfinishable after an "approve everything": the underlying code
// was never touched. Reported: "dat moet ook onderliggende code keuren".
//
// state.allBlocks is the flat, complete /api/blocks list, so it needs no
// test_class branch: those rows are synthetic (groupTestClasses, index-only)
// and their methods are ordinary blocks that are already in here — as are the
// relation children that DO stay in the left list. Synthetic comment items
// (kind:'comment') never reach allBlocks either; the guard stays as a cheap
// defence in case a future caller passes the left list instead.
function bulkApprovalTargets() {
  return state.allBlocks.filter((b) => b && b.kind !== 'comment' && b.kind !== 'test_class')
}

// retractAllApprovalsForPr clears every reviewer approval across the WHOLE PR
// in one action — the PR-wide bulk counterpart of toggleApprove/
// toggleTestClassApproval, reached via the "/" PR menu's "Alles keuren" →
// "Alle goedkeuringen intrekken" submenu (PR_COMMANDS). Walks
// bulkApprovalTargets() — every block, including the Onderliggende-code
// blocks the index hides — so it stays the exact mirror image of
// approveAllForPr below; retracting less than that action approves would
// leave underlying code approved with no way to see it in the index.
// Each block is persisted individually through the existing single-block
// `approve` Signal (persistApproval) — one Signal per block, never a batch
// write, same write path as toggleRangeApproval/applyBulkApproval; no new
// backend code. Deliberately unconditional (always clears, never toggles) —
// reached only through its own submenu, not a repeatable keybinding, so
// there is no "nothing to do" case worth special-casing.
function retractAllApprovalsForPr() {
  for (const b of bulkApprovalTargets()) {
    b.approvedRows = []
    b.approvedCalls = []
    persistApproval(b)
  }
}

// approveAllForPr approves every changed row across the WHOLE PR in one
// action — the mirror image of retractAllApprovalsForPr, reached via the
// same "/" PR menu's "Alles keuren" → "Alle code aanpassingen goedkeuren"
// submenu (PR_COMMANDS). Mirrors applyBulkApproval's own "approve
// everything" branch: a row-level approval needs the loaded diff to compute
// changedRows, so every target is ensureCode'd first (in parallel); then
// approvedRows becomes every changed row and approvedCalls is cleared — a
// full-row approval already covers whatever call-level detail it would
// otherwise carry (see toggleCallApprove's own "graduates into
// b.approvedRows" doc comment). Walks bulkApprovalTargets() — the same set
// retractAllApprovalsForPr clears, i.e. state.allBlocks, so the
// Onderliggende-code blocks the index hides are approved too (see that
// helper's own doc comment). Each block is persisted individually through
// the existing single-block `approve` Signal (persistApproval) — one Signal
// per block, never a batch write; no new backend code. Deliberately
// unconditional (always approves, never toggles) — reached only through its
// own submenu, not a repeatable keybinding.
//
// A block with a CONFIRMED server-side total of 0 changed rows
// (state.blockTotals, GET /api/blockstats — see "A block with zero changed
// rows has nothing to approve" in .claude/docs/approval.md) is skipped
// entirely: there is nothing to approve, and skipping it saves an ensureCode
// fetch per block. That matters now the target set includes every
// panel-only reference block, which is where most of those zero-total blocks
// live. `=== 0` (not falsy/undefined) so "stats not loaded yet" still gets
// the full treatment, same rule recomputeLeftList uses.
async function approveAllForPr() {
  const targets = bulkApprovalTargets().filter((b) => state.blockTotals[b.id] !== 0)
  await Promise.all(targets.map((b) => ensureCode(b)))
  for (const b of targets) {
    b.approvedRows = changedRows(blockRows(b))
    b.approvedCalls = []
    persistApproval(b)
  }
}

// stepListSelection is the list-mode ↑/↓ step (dir=+1 down, -1 up) while the
// keyboard cursor sits on an ordinary block, the stale-tree notice above them,
// or one of the trailing rows below them — NOT already inside the search box
// itself (see searchStepSelection for that case). It closes the sidebar into
// one circular loop:
//   stale-tree? → block0 → … → blockN → toggle-approved? → toggle-ignored? →
//   batch-action? → push-todo? → search → stale-tree?/block0
// (↑ walks the exact same loop backwards). Each trailing row (and the leading
// stale-tree stop) is only a stop when actually rendered
// (toggleRowVisible/ignoreToggleRowVisible/batchRowVisible/pushTodoRowVisible/
// state.blocksStale for the stale-tree row); the search box is always the
// loop's other end, reached via activateSearch() (which also drives real DOM
// focus, so BlockList's existing searchActive ring lights up) — stepping
// further from search itself is handled by searchStepSelection once
// state.searchActive is true. See keyboard-navigation.md.
function stepListSelection(dir) {
  if (dir > 0) {
    if (state.staleRowFocused) {
      // The stale-tree notice sits above every block — ↓ off it lands on the
      // first visible block, exactly like ↓ from the search box does at the
      // loop's other end.
      state.staleRowFocused = false
      const first = firstVisibleIndex()
      if (first >= 0) selectRow(first)
      return
    }
    if (state.pushTodoFocused) {
      // Already the bottom-most block-list stop — continue into the search box.
      state.pushTodoFocused = false
      activateSearch()
      return
    }
    if (state.batchRowFocused) {
      state.batchRowFocused = false
      if (pushTodoRowVisible()) state.pushTodoFocused = true
      else activateSearch()
      return
    }
    if (state.ignoreToggleFocused) {
      state.ignoreToggleFocused = false
      if (batchRowVisible()) state.batchRowFocused = true
      else if (pushTodoRowVisible()) state.pushTodoFocused = true
      else activateSearch()
      return
    }
    if (state.toggleFocused) {
      state.toggleFocused = false
      if (ignoreToggleRowVisible()) state.ignoreToggleFocused = true
      else if (batchRowVisible()) state.batchRowFocused = true
      else if (pushTodoRowVisible()) state.pushTodoFocused = true
      else activateSearch()
      return
    }
    const next = stepVisibleSelected(1)
    if (next === state.selected) {
      if (toggleRowVisible()) state.toggleFocused = true
      else if (ignoreToggleRowVisible()) state.ignoreToggleFocused = true
      else if (batchRowVisible()) state.batchRowFocused = true
      else if (pushTodoRowVisible()) state.pushTodoFocused = true
      else activateSearch()
      return
    }
    selectRow(next)
    return
  }
  if (state.pushTodoFocused) {
    state.pushTodoFocused = false
    if (batchRowVisible()) state.batchRowFocused = true
    else if (ignoreToggleRowVisible()) state.ignoreToggleFocused = true
    else if (toggleRowVisible()) state.toggleFocused = true
    // Nothing above: state.selected already holds the last visible block
    // (unchanged all the way through the trailing rows) — nothing to do.
    return
  }
  if (state.batchRowFocused) {
    state.batchRowFocused = false
    if (ignoreToggleRowVisible()) state.ignoreToggleFocused = true
    else if (toggleRowVisible()) state.toggleFocused = true
    return
  }
  if (state.ignoreToggleFocused) {
    state.ignoreToggleFocused = false
    if (toggleRowVisible()) state.toggleFocused = true
    // No toggle-approved row: state.selected already holds the last visible
    // block (unchanged all the way through the toggle rows) — nothing to do.
    return
  }
  if (state.toggleFocused) {
    state.toggleFocused = false
    return
  }
  if (state.staleRowFocused) {
    // Already the top-most block-list stop — continue up into the search box,
    // mirroring pushTodoFocused's own step further down into it.
    state.staleRowFocused = false
    activateSearch()
    return
  }
  const prev = stepVisibleSelected(-1)
  if (prev === state.selected) {
    // Topmost visible block already reached — the stale-tree notice (if any)
    // is its permanent up-neighbour, else continue straight into the search
    // box (its permanent up-neighbour in the loop above).
    if (state.blocksStale) {
      state.staleRowFocused = true
      return
    }
    activateSearch()
    return
  }
  selectRow(prev)
}

// searchStepSelection is the ↑/↓ step while the search box already holds real
// DOM focus (state.searchActive). Two distinct behaviours, gated on
// state.searchLoopFocused — NOT on whether state.search is empty, because the
// search box also ends up with real DOM focus ambiently (a browser quirk:
// the sole text input on the page gets initial focus on a fresh load/reload,
// well before the reviewer has done anything — see the "leave the
// auto-focused search box" Escape presses sprinkled through the test suite).
// Gating on an empty query would make that ambient, unintentional focus
// indistinguishable from a deliberate arrival via the loop below, and every
// plain ArrowDown right after load would misfire straight back to the first
// block instead of just walking the list.
// - state.searchLoopFocused (only ever set by stepListSelection's own
//   loop-boundary transitions below, and by nothing else — see
//   activateSearch/exitSearch): the box is purely the loop's other end. ↓
//   exits onto the first visible block, ↑ exits onto the toggle-ignored row,
//   else the toggle-approved row, else the last visible block — whichever of
//   those is the search box's actual up-neighbour in the loop right now.
// - Otherwise (ambient focus from load/reload, or the reviewer clicked into
//   the box and is actively typing a filter): keep the EXISTING
//   behaviour — walk the (possibly filtered) list while focus stays in the
//   box, with its own wrap at either end. Deliberately unchanged from before
//   this loop existed, and deliberately only ever reaches toggle-approved
//   (never toggle-ignored) — this narrow, already-documented "browse while
//   typing" feature keeps its old, simpler shape; the new toggle-ignored/
//   search loop below is about deliberate keyboard navigation only.
function searchStepSelection(dir) {
  if (state.searchLoopFocused) {
    exitSearch()
    if (dir > 0) {
      const first = firstVisibleIndex()
      if (first >= 0) selectRow(first)
      return
    }
    // Going up from search always lands on the last visible block underneath
    // whichever stop is next (a toggle row, or the block itself) — unlike the
    // down-from-toggle-rows case, state.selected can't be trusted to already
    // hold that index here: the reviewer may have gotten to this exact spot
    // via a full ↓ wrap-around (which resets state.selected to the FIRST
    // visible block), so it must be set explicitly on every branch below.
    const last = lastVisibleIndex()
    if (last >= 0) selectRow(last)
    if (pushTodoRowVisible()) {
      state.pushTodoFocused = true
      return
    }
    if (batchRowVisible()) {
      state.batchRowFocused = true
      return
    }
    if (ignoreToggleRowVisible()) {
      state.ignoreToggleFocused = true
      return
    }
    if (toggleRowVisible()) {
      state.toggleFocused = true
      return
    }
    return
  }
  if (dir > 0) {
    if (state.toggleFocused) return // already the bottom-most stop
    const next = stepVisibleSelected(1)
    if (next === state.selected && toggleRowVisible()) {
      state.toggleFocused = true
      return
    }
    selectRow(next)
    return
  }
  if (state.toggleFocused) {
    state.toggleFocused = false
    return
  }
  const prev = stepVisibleSelected(-1)
  if (prev === state.selected) {
    const last = lastVisibleIndex()
    if (last >= 0) selectRow(last)
    return
  }
  selectRow(prev)
}

// revealSelectedIfHidden pins the restored selection visible when it points at
// a fully-approved block, instead of unfolding the whole approved section.
// A selection restored from the URL (?sel=file:line via applyBlockRefRestore)
// is the reviewer's OWN position: moving it away to the first visible block
// (the clampSelectedToVisible behaviour used for search) read as a lost
// selection, but unfolding EVERY approved block PR-wide just to show this one
// (the old state.showApproved = true behaviour) revealed far more than the
// reviewer asked for. state.pinnedApprovedId + BlockList.mjs's renderList (a
// per-row exception for i === state.selected && b.id === pinnedApprovedId)
// keep exactly that one row visible/selected; every other approved block
// stays hidden. Already visible (or no block at all) → no-op. Called ONLY
// from the load path — never from the live approve flow (approving the block
// you're currently looking at still hides it immediately, since
// pinnedApprovedId is never set there — see
// tests/selected-reveal-hidden.spec.mjs), and deliberately NOT from setSearch
// (see clampSelectedToVisible below).
function revealSelectedIfHidden() {
  const b = state.blocks[state.selected]
  if (!b) return
  if (!isFullyApproved(state, b)) return
  state.pinnedApprovedId = b.id
  scrollSelectedIntoView()
}

// revealApprovedBlocks is what a click/Enter/ArrowRight on the toggle-approved
// row runs (mirrors toggleRow's own @click in BlockList.mjs, threaded in as
// the onRevealApproved callback — BlockList.mjs can't import selectRow/
// scrollSelectedIntoView itself, since home.mjs already imports BlockList.mjs).
// Reviewer request: "toon x goedgekeurde blok, moet gelijk naar de index item
// gaan met een goedgekeurde blok" — clicking "Toon N goedgekeurde blocks" used
// to only flip state.showApproved and leave the keyboard/selection sitting on
// the toggle row itself, so the reviewer had to walk ↑ manually into the
// section that just unfolded. Turning the section ON now jumps straight to
// the FIRST now-visible approved block (in list order, i.e. state.blocks'
// own order — approved blocks sit inline where they always belonged, not
// bunched below the toggle row, see renderList in BlockList.mjs). Turning it
// back OFF (hiding) stays a plain flip: there's no "index item" to land on
// when collapsing a section.
function revealApprovedBlocks() {
  const turningOn = !state.showApproved
  state.showApproved = !state.showApproved
  if (!turningOn) return
  const idx = state.blocks.findIndex((b) => isFullyApproved(state, b))
  if (idx < 0) return
  selectRow(idx)
  state.toggleFocused = false
  state.ignoreToggleFocused = false
  state.batchRowFocused = false
  state.pushTodoFocused = false
  state.staleRowFocused = false
  state.blockIndexEntered = true
  scrollSelectedIntoView()
}

// applyDefaultUnapprovedSelection lands a genuinely fresh open (no ?sel=
// restored at all — see hadSelParam in loadBlocks) on the first not-yet-
// fully-approved item in state.blocks. Deliberately no distinction between a
// top-level Start block and an underlying-code child (recomputeLeftList/
// BlockList.mjs's renderList already treat them as one flat, ordered list,
// and so does ↑/↓ via stepVisibleSelected) — either can win. If every item is
// already fully approved (or there are no blocks at all), there's nothing to
// select: instead land the keyboard on the toggle-approved row (mirrors
// stepListSelection's own ↓-past-the-end stop), provided that row actually
// exists (toggleRowVisible). Called only from the load path, after
// loadApprovals/loadBlockStats have landed (see loadBlocks) — isFullyApproved
// depends on state.approvalSummaries, which isn't known any earlier.
//
// Among ORDINARY blocks (defaultSelectionRank === 0) the tie-break is FILE
// ORDER (smallest `(file, line)`), not state.blocks' own array order —
// reviewer request: "als ik een gegenereerde PR open, wil ik naar eerste
// aangepaste bestand toe". state.blocks is sorted by recomputeLeftList's
// fileRank (the file with the most underlying blocks first, TEST always last
// — see "Sort order of the left list" in .claude/docs/blocks-and-ingest.md),
// which is a DISPLAY grouping, not "where a fresh open should land"; picking
// the array-order winner used to land on whichever file ranked first (e.g. a
// file with many underlying blocks but touched near the end of the diff)
// instead of the first block of the first-changed file. Comment items (rank
// 1/2/3) are UNAFFECTED — their
// own tie-break stays plain array/display order, exactly as before; see
// defaultSelectionRank's own comment for why that priority must not move.
//
// freshDefaultSelectionPending/freshDefaultSelectionAt back a RETRY of this
// same pick once the PR-wide comment list (see
// recomputeLeftList's rank, now 2.4 for the ordinary section) arrives — comment items are populated by
// RelatedPanel's own, independent comment poll (loadComments), which now
// awaits ensureMe() before pushing cs.list (see avatar.mjs — the reviewer's
// own GitHub identity lookup), an extra network round trip that can land
// well after this function's one-shot call in loadBlocks already picked an
// ordinary block/the toggle row. Since a comment item now ranks BELOW an
// ordinary block (see below), this retry in practice only ever matters when
// there was no unapproved ordinary block to begin with (the fresh pick then
// fell through to the toggle row, or to nothing at all) — a comment item
// arriving late can still claim that empty slot. freshDefaultSelectionAt
// snapshots the picked block's stable id (not its raw index —
// recomputeLeftList reindexes existing rows by id when the comment watch
// inserts new items, so the id is what stays stable across that reindex)
// resp. `true` for the toggle-row pick, so retryDefaultSelectionForComments
// can tell whether nothing else (a click, an arrow key, a restored ?sel=)
// has since moved the selection away from that automatic pick.
// defaultSelectionRank is a SEPARATE priority order from recomputeLeftList's
// own display `rank()` above, used only to decide which unapproved item a
// fresh open auto-selects. The two are deliberately NOT identical: a comment
// item's display position (rank 2.4, "gooi algemene pr comments net boven
// Comments op regels") is about where it SHOWS in the list, not about which
// item wins a fresh open.
//
// REVERSED 2026-08-20 (explicit reviewer request, overriding the earlier one
// below): a fresh open must land on the first not-yet-approved ORDINARY
// block first — "als ik een gegenereerde PR open, wil ik naar het eerste
// aangepaste code-item in de blokken-index, als die er niet zijn is het prima
// om naar het volgende (een comment-item) te gaan". Before this, a no-regel
// PR-wide comment (mentioned or not) unconditionally outranked every real
// block, so a fresh open with both an unresolved comment AND unapproved code
// always landed on the comment — including via retryDefaultSelectionForComments
// yanking an already-picked block away once the (asynchronous) comment poll
// landed. That was itself a deliberate, explicit reviewer request at the
// time (see tests/comment-index-items.spec.mjs's history) — this is a
// genuine reversal of that earlier decision, not an oversight, and it is not
// to be "fixed back" by a later session without another explicit request.
// Do NOT re-introduce "comment outranks block" here.
function defaultSelectionRank(b) {
  if (b.kind !== 'comment') return 0
  if (b.lineAnchored) return 3
  return b.mentioned ? 1 : 2
}

function applyDefaultUnapprovedSelection() {
  let idx = -1
  let bestRank = Infinity
  let bestFile = null
  let bestLine = Infinity
  state.blocks.forEach((b, i) => {
    if (isFullyApproved(state, b)) return
    const r = defaultSelectionRank(b)
    if (r < bestRank) {
      bestRank = r
      bestFile = b.file
      bestLine = b.line
      idx = i
      return
    }
    // Same rank: only ordinary blocks (rank 0) re-tie-break by file order —
    // a comment tie keeps array/display order, untouched (see doc above).
    if (r === bestRank && r === 0 && bestFile != null && (b.file < bestFile || (b.file === bestFile && b.line < bestLine))) {
      bestFile = b.file
      bestLine = b.line
      idx = i
    }
  })
  if (idx >= 0) {
    state.selected = idx
    // A comment-index item (kind:'comment') has no diff — a stray restored
    // `?mode=diff` (with no matching ?sel=, so this default-landing path ran
    // at all) must not leave the app in diff mode with nothing to show one.
    if (state.blocks[idx].kind === 'comment') state.mode = 'list'
    state.toggleFocused = false
    state.pushTodoFocused = false
    state.batchRowFocused = false
    state.staleRowFocused = false
    scrollSelectedIntoView()
    freshDefaultSelectionAt = { blockId: state.blocks[idx].id }
    return
  }
  if (toggleRowVisible()) {
    state.toggleFocused = true
    freshDefaultSelectionAt = { toggle: true }
  } else {
    freshDefaultSelectionAt = null
  }
}

// retryDefaultSelectionForComments re-applies applyDefaultUnapprovedSelection
// once the PR-wide comment list changes (see the watch on indexComments()
// below) — but only as long as the selection is still exactly where the last
// automatic pick left it (see freshDefaultSelectionAt's own comment above);
// any other outcome means the reviewer (or some other restore path) has
// since moved on, so retrying would wrongly yank the selection back.
// Deliberately consumed AT MOST ONCE (freshDefaultSelectionPending is always
// cleared here, whether or not it actually reapplies): the comment list can
// legitimately change again much later in the same session (a new comment
// gets imported while the reviewer is mid-review) and that must never yank
// the selection back to a "fresh open" pick at that point — this retry only
// exists to give the *initial* comment load, delayed behind loadComments'
// own ensureMe() round trip, one fair shot at the very selection
// loadBlocks' one-shot call otherwise already raced past.
function retryDefaultSelectionForComments() {
  if (!freshDefaultSelectionPending) return
  freshDefaultSelectionPending = false
  // Only from the REST position (the blokken-index itself). Once the reviewer
  // has stepped into the diff, a late-arriving comment row must never yank the
  // selection out from under him — and since every unresolved comment now gets
  // such a row (see recomputeLeftList), the most common trigger is the reviewer
  // PLACING a comment himself: its own fresh index row lands a poll later, ranks
  // first, and used to become "the first not-yet-approved item" this would then
  // jump to, abandoning the diff he was working in.
  if (state.mode !== 'list') return
  const at = freshDefaultSelectionAt
  const stillAtPick = at
    ? at.toggle
      ? state.toggleFocused
      : !state.toggleFocused && state.blocks[state.selected] && state.blocks[state.selected].id === at.blockId
    : !state.toggleFocused && state.blocks.length === 0
  if (!stillAtPick) return
  applyDefaultUnapprovedSelection()
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
    selectRow(idx)
    scrollSelectedIntoView()
  }
}

// setSearch is the search box's input handler: refilter the left list and jump
// the selection to the top match so ↑/↓ walk the results from the first hit.
function setSearch(q) {
  state.search = q
  recomputeLeftList()
  state.selected = 0
  // Typing is a fresh navigation reset — a Shift+arrow multi-row selection
  // from before the filter changed can't survive it (see clearListAnchor).
  clearListAnchor()
  state.classMethodSel = 0
  state.testColumnFocused = false
  // Typing is a fresh navigation reset — never leave the keyboard cursor
  // parked on the toggle-approved row from a previous, now-irrelevant walk.
  state.toggleFocused = false
  state.pushTodoFocused = false
  state.batchRowFocused = false
  state.staleRowFocused = false
  // Typing is also a deliberate switch to the "browse while typing" feature
  // (see searchStepSelection): it must win over an earlier, still-pending
  // loop-stop arrival, so the very next ArrowDown/ArrowUp walks the filtered
  // results instead of exiting the box.
  state.searchLoopFocused = false
  // The top match can be a hidden (fully-approved) block — land on the first
  // visible one instead so a row always highlights (see clampSelectedToVisible;
  // deliberately a clamp, not a reveal — see the comments above).
  clampSelectedToVisible()
  scrollSelectedIntoView()
}

// focusSearchBox is the low-level primitive: flip state.searchActive AND
// drive real DOM focus (the box's @focus/@blur mirror the flag back, so a
// mouse click stays in sync) — nothing more. Used by the load-time
// convenience focus below (a diff-mode deep link never calls this, see its
// own guard) and by activateSearch, which additionally marks the arrival as
// a DELIBERATE loop stop.
function focusSearchBox() {
  state.searchActive = true
  const el = document.getElementById('block-search')
  if (el) el.focus()
}

// activateSearch moves the keyboard into the search box AS A DELIBERATE LOOP
// STOP (state.searchLoopFocused — see searchStepSelection for why this is a
// separate flag from state.searchActive itself: the box also ends up focused
// for reasons that are NOT a loop arrival, namely the load-time convenience
// focus below and a plain click to start typing — searchLoopFocused stays
// false for both of those). Reached by stepListSelection (↓ past the last
// block-list stop, or ↑ from the topmost visible block — see the sidebar's
// ↑/↓ loop there). Left again via searchStepSelection (↓/↑ while
// state.searchLoopFocused is true), or by → / Enter (step into the diff) or
// Escape (back to the list) — those last two, and typing (setSearch), always
// clear searchLoopFocused too via exitSearch, regardless of how the box got
// focus.
function activateSearch() {
  focusSearchBox()
  state.searchLoopFocused = true
}

function exitSearch() {
  state.searchActive = false
  state.searchLoopFocused = false
  const el = document.getElementById('block-search')
  if (el) el.blur()
}

// resolvedCallTargetIds returns the ids of PR blocks that are the definition of
// some resolved/found method call — the blocks that surface in a RelatedPanel's
// "Onderliggende code" (prio 0 in resolvedCallChildren). Those are pulled from
// the left list, like relation children. EXCEPT a target that testCallTargetIds
// already claims (a TEST caller resolved-calling the very method it exercises)
// — that target stays visible instead, see testCallTargetIds below.
function resolvedCallTargetIds() {
  const prBlockIds = new Set(state.allBlocks.map((x) => x.id))
  const testTargets = testCallTargetIds()
  const ids = new Set()
  for (const r of state.callResolve || []) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    // A translation child points at a lang file and never hides its standalone
    // TRANSLATION block from the left list — both stay visible (the block in the
    // list, the key value as a child), like test coverage.
    if (r.kind === 'translation') continue
    // A config('file.key.path')/.env.example child (resolveConfigCalls) never
    // has a childClass/childMethod that could compose into a real block id in
    // practice (a config file's own PR block, if this PR also edits it
    // directly, is a CONFIG-category wholeFileBlock keyed by its filename, not
    // by an empty childMethod) — excluded anyway, same defensive precedent as
    // translation above, so such a legitimately-changed config file never gets
    // hidden from the left list by accident.
    if (r.kind === 'config_value' || r.kind === 'env_example') continue
    // A class-member child (a property/constant declaration, see
    // CLASS_MEMBER_KINDS) used to be skipped here because a member was never a
    // block. Since splitClassHeaderMembers (phpscan.go) a CHANGED member IS a
    // PR block of its own, and hiding its standalone index row once it shows as
    // Onderliggende code under the method that uses it is the whole point of
    // the split. An UNCHANGED constant still composes to no existing id, so the
    // prBlockIds test below leaves it alone by itself. The old collision worry
    // (a method named exactly like a constant) is handled at the source
    // instead: splitClassHeaderMembers refuses to mint a member block whose
    // symbol another block in the file already owns.

    // A class's constructor / first method shown next to a Foo::class
    // reference (rule 6c-bis) is INCIDENTAL reference material — it is picked
    // because it introduces the class, not because this PR touched it. On the
    // rare occasion the PR did change it, it stays a first-class review row of
    // its own AND shows as this reference card (explicit answer: "gewoon
    // tonen"), same both-ways rule as translation/test targets above.
    if (r.kind === 'class_ctor' || r.kind === 'class_first_method') continue
    const childId =
      blockIdPrefix() + ':' + r.childFile + ':' + (r.childClass ? r.childClass + '::' + r.childMethod : r.childMethod)
    if (prBlockIds.has(childId) && !testTargets.has(childId)) ids.add(childId)
  }
  return ids
}

// testCallTargetIds returns the ids of PR blocks that are the definition of a
// resolved/found method call made FROM a TEST-category caller — e.g. a test
// method directly calling the production method it exercises (as opposed to
// only covering it via a @covers annotation, see testCoverTargetIds). Mirrors
// that same, deliberate exemption: such a target is ALWAYS primary, reviewable
// PR code, not incidental reference code, so resolvedCallTargetIds must not
// hide it from the left list — recomputeLeftList instead keeps it visible,
// sorted under the "Onderliggende code" heading like a relation child.
function testCallTargetIds() {
  const prBlockIds = new Set(state.allBlocks.map((x) => x.id))
  const callerCategory = new Map(state.allBlocks.map((b) => [b.id, b.category]))
  const ids = new Set()
  for (const r of state.callResolve || []) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    if (callerCategory.get(r.callerId) !== 'TEST') continue
    const childId =
      blockIdPrefix() + ':' + r.childFile + ':' + (r.childClass ? r.childClass + '::' + r.childMethod : r.childMethod)
    if (prBlockIds.has(childId)) ids.add(childId)
  }
  return ids
}

// A <class-header> block used to be pulled from the index whenever its members
// showed as Onderliggende code under a sibling method (swallowedClassHeaderIds,
// removed). That whole mechanism is gone: since splitClassHeaderMembers
// (phpscan.go) the members are no longer IN the header block — each is a block
// of its own, hidden from the index by the ordinary resolvedCallTargetIds path
// once something references it — and what is left in a <class-header> block
// (the class's `use Trait;` statements) is real changed code that must keep its
// own approvable row. A header consisting of nothing but members leaves no
// block at all, so there is nothing left to swallow either.

// loadCallResolve fetches the PR's call-resolution rows into state. Best-effort:
// a transient failure just yields no rows. Reassigns the array so arrow.js
// re-renders the Onderliggende-code panel when a search completes.
async function loadCallResolve() {
  try {
    const res = await fetch(`/api/callresolve?pr=${state.pr}${repoQuery}`)
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

// pendingPushSyncedSha tracks, per this TAB only (never reactive — a plain
// module variable, same shape as codeRequested/lastFiredSelectionRef), the
// pending-ref sha this tab's own tree last caught up to. `undefined` means
// "no baseline yet" (right after page load, before loadPendingPush's first
// read) — see the backstop below.
let pendingPushSyncedSha

// loadPendingPush fetches whether this PR has landed-but-unpushed Claude edits
// (GET /api/pending-push, pending_push.go). Claude's own commits land on a
// LOCAL ref of the PR's branch so the code is reviewable right away; pushing
// them to GitHub is the reviewer's own last step, driven from the todo row at
// the bottom of the index (pushTodoRow in BlockList.mjs).
//
// Assigns the whole object (or null) rather than mutating it, so every reactive
// reader — the todo row, its counter, the per-block "ongepusht" marking — sees
// the change (see the keyed-node pitfall in arrowjs-pitfalls.md). Best-effort:
// offline simply keeps whatever we had.
//
// Also doubles as the backstop for a MISSED blocks.changed frame (reviewer
// report: "na een claude aanpassing blijft het zoeken naar nieuwe aanpassing,
// niet zichtbaar — na handmatig herladen zie ik het wel"). blocks.changed is
// deliberately excluded from onEventsResync (a bare reconnect must never raise
// a false stale-tree notice, see server-events.md), and the ordinary
// ingest-refresh poller can never fill that gap for a landed-but-unpushed
// commit — it only reacts to the PR's REMOTE head moving, which such a commit
// never does (see .claude/docs/pending-push.md). This poll is git+DB-backed
// (row.treeCaughtUp, pending_push.go), not event-sourced, so it eventually
// observes the truth regardless of any dropped SSE frame.
//
// Because it is git+DB-backed rather than event-sourced, this same read is
// ALSO run on a slow timer (PENDING_PUSH_POLL_MS below), not only on the
// pendingpush.changed frame and the resync hook. Reviewer report: "ik zie de
// aanpassing niet verschijnen, ook na 10 seconden niet, als ik dan refresh
// wel... ik heb dit vaker meegemaakt" — with a landing whose blocks.changed
// AND pendingpush.changed frames both go missing (a full subscriber buffer, a
// stream that died between the two), nothing else in the tab ever asks again:
// blocks.changed is excluded from onEventsResync by design, and the server
// only re-offers a `resync` on the next event or its 20s keepalive tick. The
// timer makes the recovery unconditional and bounded instead of "whenever the
// next frame happens to arrive", without adding a second source of truth —
// it is the exact same read, and the guard below is what keeps it a no-op.
//
// The trigger is deliberately narrow, to hold the hard rule "never on a bare
// reconnect without pending work": only when row.treeCaughtUp is true AND its
// sha is one this tab hasn't already caught up to (pendingPushSyncedSha) —
// i.e. the backend has genuinely finished re-ingesting a landing this tab
// hasn't shown yet. The very FIRST read after page load only establishes that
// baseline and never fires — loadBlocks() already handles a fresh page load,
// and firing here too would refetch on every ordinary open of a PR that
// happens to have older, already-reviewed unpushed work sitting on it.
async function loadPendingPush() {
  try {
    const res = await fetch(`/api/pending-push?prs=${encodeURIComponent(prUidHere())}`)
    if (!res.ok) return
    const data = await res.json()
    const row = data && data.pending ? data.pending[String(state.pr)] : null
    state.pendingPush = row || null
    // The row appears/disappears at the very bottom of the index, so a keyboard
    // cursor parked on it must not be left pointing at nothing.
    if (!state.pendingPush) state.pushTodoFocused = false
    if (pendingPushSyncedSha === undefined) {
      pendingPushSyncedSha = row ? row.sha : null
    } else if (!row) {
      pendingPushSyncedSha = null
    } else if (row.treeCaughtUp && row.sha !== pendingPushSyncedSha) {
      pendingPushSyncedSha = row.sha
      refreshBlocksAfterOwnLanding(row.files || [])
    }
    // row.treeCaughtUp === false: leave pendingPushSyncedSha as-is — nothing
    // new to show yet, and the ordinary blocks.changed path already handles
    // the moment the backend's own refresh completes, when that frame does
    // arrive.
  } catch (_) {
    /* offline — keep whatever we have */
  }
}

// PENDING_PUSH_POLL_MS is the cadence of loadPendingPush's own timer (see its
// doc comment): a local-only read (for-each-ref + rev-list --count + diff
// --name-only, no network, no gh), so it is cheap enough to run unconditionally
// — the same shape as pollWorkflows/pollProblems above. Slow on purpose: it
// exists to bound how long a MISSED event can hide a finished landing, not to
// be the primary path (the ordinary blocks.changed frame still gets there
// first and makes this tick a no-op via pendingPushSyncedSha).
const PENDING_PUSH_POLL_MS = 10_000

// pushPendingWork fires the actual push: a "push" Action on the PR's chat_merge
// queue (the same queue that serializes landings, see chat_merge.go), never a
// direct write from here. Only reachable through the confirm submenu
// (pushTodoConfirmCommands), so this itself asks nothing further.
//
// The response says only that the Signal was accepted; the outcome arrives as a
// pendingpush.changed event (which refetches the read model, flipping the row to
// "pushen…" and then away entirely — or to "push mislukt" with a reason).
async function pushPendingWork() {
  const p = state.pendingPush
  if (!p || !p.pushRunId) return
  try {
    await fetch(`/api/workflows/${p.pushRunId}/signals/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push' }),
    })
  } catch (_) {
    /* best-effort — the row keeps showing the work as unpushed */
  }
  loadPendingPush()
}

// pendingPushFiles is the set of file paths touched by the not-yet-pushed
// commits, used to mark those blocks in the index/diff as unpushed. Empty set
// when there's nothing pending.
function pendingPushFiles() {
  const p = state.pendingPush
  return new Set(p && Array.isArray(p.files) ? p.files : [])
}

// checkoutPendingFiles is pendingPushFiles' twin for the OTHER, earlier
// status: files a not-yet-landed Claude edit is touching right now
// (state.checkout.pendingFiles, chat_edit_pending.go via loadCheckout below).
// Empty set when nothing is pending or the checkout hasn't loaded yet.
function checkoutPendingFiles() {
  const c = state.checkout
  return new Set(c && Array.isArray(c.pendingFiles) ? c.pendingFiles : [])
}

// checkoutRefreshingFiles is checkoutPendingFiles' twin for the THIRD status:
// files a Claude edit just LANDED for, that the review tree hasn't
// re-ingested yet (state.checkout.refreshingFiles, chat_refresh_pending.go
// via loadCheckout below). Empty set when nothing is pending a refresh or the
// checkout hasn't loaded yet. Also doubles as the signal the `blocks.changed`
// handler uses to tell "my own landing just finished refreshing" apart from
// "a colleague pushed" — see onEvent('blocks.changed', ...) below.
function checkoutRefreshingFiles() {
  const c = state.checkout
  return new Set(c && Array.isArray(c.refreshingFiles) ? c.refreshingFiles : [])
}

// loadCheckout fetches this PR's shared local-checkout state (the checkout
// chip in prInfoCard) — GET /api/chat/checkout, chat_checkout.go's
// buildCheckoutView. Assigns the whole object (or null) rather than mutating
// it, same reactivity reasoning as loadPendingPush. Best-effort: offline
// simply keeps whatever we had.
async function loadCheckout() {
  try {
    const res = await fetch(`/api/chat/checkout?prs=${encodeURIComponent(prUidHere())}`)
    if (!res.ok) return
    const data = await res.json()
    const row = data && data.checkout ? data.checkout[prUidHere()] : null
    state.checkout = row || null
  } catch (_) {
    /* offline — keep whatever we have */
  }
}

// refreshBlocksAfterOwnLanding re-fetches the blocks/relations the moment the
// ingest-refresh triggered by the REVIEWER'S OWN just-landed Claude edit
// completes — the `blocks.changed` handler below only calls this when
// checkoutRefreshingFiles() was non-empty right before the event arrived
// (i.e. this event is that landing catching up, not a colleague's push,
// which keeps going through the existing staleTreeRow/state.blocksStale
// flow untouched). Reviewer request: "als claude net een aanpassing heeft
// gedaan... dan wil ik dat gelijk zien" — the existing flow required a
// manual click on the stale-tree notice; this one is safe to do
// automatically because the reviewer just asked for this exact change
// themselves; see .claude/docs/pending-push.md.
//
// Deliberately NOT the full loadBlocks() (only meant to run once, at page
// load — it re-derives one-shot restores like ?sel=/?drill= and the
// fresh-open default-unapproved pick, none of which apply to a mid-session
// refresh): just the two reads loadBlocks itself starts with
// (blocks + relations), then recomputeLeftList's existing id-preserving
// reindex, with one addition — if the CURRENTLY selected block just
// disappeared because of this exact edit (the method/class it was on got
// removed or moved out), land on another block from one of the SAME files
// this landing touched, rather than recomputeLeftList's generic "reset to
// the first row" fallback. No such candidate → that generic fallback stands,
// unchanged.
async function refreshBlocksAfterOwnLanding(touchedFiles) {
  const prevId = state.blocks[state.selected] ? state.blocks[state.selected].id : null
  try {
    const res = await fetch(`/api/blocks?pr=${state.pr}${repoQuery}`)
    if (!res.ok) return
    const blocks = await res.json()
    // The fresh block objects carry no `b.code` (GET /api/blocks never does),
    // so drop the per-block "already fetched" marks for the files this landing
    // touched BEFORE they are mounted — otherwise ensureCode's own cache guard
    // returns immediately for every one of them and the diff column keeps
    // showing the pre-landing source (or nothing at all). See
    // invalidateCodeCache's own comment.
    invalidateCodeCache(touchedFiles)
    state.allBlocks = Array.isArray(blocks) ? blocks : []
    state.relations = await loadRelations()
  } catch (_) {
    return // offline — keep whatever we had, the next event/poll retries
  }
  recomputeLeftList()
  const stillThere = prevId != null && state.blocks.some((b) => b.id === prevId)
  if (prevId != null && !stillThere && Array.isArray(touchedFiles) && touchedFiles.length) {
    const files = new Set(touchedFiles)
    const idx = state.blocks.findIndex((b) => b.file && files.has(b.file))
    if (idx >= 0) state.selected = idx
  }
  // An OPEN drilled column (state.drill) still holds the block objects from
  // before the refresh — stale code, and stale approvals once loadApprovals
  // above has only touched the fresh ones. Re-point every level at the new
  // object with the same id (a synthetic drill frame carries its source
  // inline and has no stored block, so it stays exactly as it is; an id that
  // no longer exists keeps its old object rather than collapsing the column).
  // Reassigned only when something really moved, so the ?drill= mirror and the
  // columns render are not nudged for nothing; the cursor state
  // (state.drillCursor, per level) is index-based and unaffected.
  if (state.drill.length) {
    const byId = new Map(state.allBlocks.map((b) => [b.id, b]))
    const next = state.drill.map((d) => (d && !d.synthetic && byId.get(d.id)) || d)
    if (next.some((d, i) => d !== state.drill[i])) state.drill = next
  }
  // The newly landed code can resolve new calls/tests/approval totals — the
  // same fire-and-forget reads loadBlocks itself kicks off.
  loadCallResolve()
  loadTestCovers()
  // The reviewer's per-row approvals live ON the block objects
  // (b.approvedRows/b.approvedCalls, see loadApprovals), which the fresh ones
  // above do not have — without re-reading them the checkmarks and the
  // "approve N/M" counter simply vanished from every refreshed block until a
  // page reload.
  //
  // Ordered exactly like loadBlocks: recomputeLeftList FIRST, then this pair,
  // then one more recompute (state.blockTotals only lands here, and a block
  // that is now fully approved has to drop out of the visible list). Running
  // loadApprovals BEFORE that first recompute instead wedged the selected
  // card's diff completely — it reassigns state.allBlocks wholesale, which
  // mid-swap collides with the card's own keyed rebuild (the co-subscriber /
  // keyed-node pitfalls in .claude/rules/arrowjs-pitfalls.md): the code was
  // fetched and codeDiff even ran, but its DOM never mounted, leaving a
  // header-only card. Reproduced and fixed in tests/refreshing-pill.spec.mjs.
  await Promise.all([loadApprovals(), loadBlockStats()])
  recomputeLeftList()
  // Whichever path got here first (the ordinary blocks.changed event, or the
  // loadPendingPush backstop above) — record the sha this tab is now caught up
  // to, so the OTHER path doesn't redundantly refetch again moments later for
  // the same landing.
  if (state.pendingPush && state.pendingPush.sha) pendingPushSyncedSha = state.pendingPush.sha
}

// sendCheckoutAction fires one of the checkout chip's four Actions
// (checkoutRelist/checkoutAnswer/checkoutOff/checkoutRestoreStash) on the
// PR's chat_merge queue — never a direct write from here. The queue
// Execution is ensured FIRST, every time: unlike pushPendingWork (only
// reachable once something has already landed, which already guarantees the
// queue exists), the checkout chip is reachable before anything has ever
// landed/relisted for this PR, so the Execution may genuinely not exist yet.
// StartWorkflowID is idempotent, so ensuring an already-running queue costs
// nothing extra.
//
// The response only says the Signal was accepted; the outcome arrives as a
// checkout.changed event (which refetches the read model) — same
// fire-and-refetch shape as pushPendingWork.
//
// `action === 'checkoutAnswer' && reply` (an actual candidate picked, never
// "Uit"/"Andere werkmap kiezen"/"Nu terugzetten") also tries to resume a chat
// column stuck on the "keuze open over de werkmap" dead-end — reviewer-report:
// making the choice resolved it, but the chat itself showed nothing new and
// never continued, so the reviewer had to retype the original request by
// hand. See resumeStuckClaudeAfterCheckout's own doc comment (RelatedPanel.mjs)
// for why this is scoped to whichever conversation is currently on screen.
async function sendCheckoutAction(action, reply) {
  let runId = state.checkout && state.checkout.runId
  try {
    const res = await fetch('/api/workflows/chat_merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr, repo: state.repo }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.runId) runId = data.runId
    }
  } catch (_) {
    /* best-effort */
  }
  if (!runId) return
  try {
    await fetch(`/api/workflows/${runId}/signals/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reply ? { action, reply } : { action }),
    })
  } catch (_) {
    /* best-effort */
  }
  if (action === 'checkoutAnswer' && reply) resumeStuckClaudeAfterCheckout(reply)
  loadCheckout()
}

// loadExplanations fetches the PR's AI unit-explanations into state (keyed
// `${blockId}|${unitKey}`). Best-effort: a transient failure just yields no
// rows. Reassigns the map wholesale so the footer watch re-fires when a
// generation completes.
async function loadExplanations() {
  try {
    const res = await fetch(`/api/explanations?pr=${state.pr}${repoQuery}`)
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
    const res = await fetch(`/api/testcovers?pr=${state.pr}${repoQuery}`)
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
    const res = await fetch(`/api/relations?pr=${state.pr}${repoQuery}`)
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

// refreshSinceReview asks this PR's pr_status tracker to re-derive "what
// changed since MY last review" (the sky blocks under "Doel", sinceReviewBlocks).
// Its two stages only ever ran once, when the tracker was first started, while
// the tracker itself is reused for the PR's whole lifetime — so without this
// the block stayed empty/stale even though the PR overview's own "nieuw sinds
// jouw review" line (computed live) already said there was something new. A
// Signal is a sanctioned UI write path (start/signal only, see
// .claude/rules/workflows-write-boundary.md); the backend skips the LLM call
// when the facts are unchanged, so one signal per page load is cheap.
// Fire-and-forget: the result arrives via pollPRMeta or 'prmeta.changed'.
function refreshSinceReview(runId) {
  fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshSince: true }),
  }).catch(() => {
    /* offline — the block just keeps whatever the read-model already had */
  })
}

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
    body: JSON.stringify({ pr: state.pr, repo: state.repo || undefined }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body && body.runId) {
        state.prStatusRunId = body.runId
        startPRStatusHeartbeat()
        refreshSinceReview(body.runId)
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

// fetchPRMetaOnce reads the prmeta read-model once into state.prMeta and
// returns whether the review/checks stage has landed. Shared by pollPRMeta's
// progressive load and the 'prmeta.changed' event handler below (which needs
// exactly one refetch, not a new poll loop). Read-only; a failure leaves the
// last-known data in place.
async function fetchPRMetaOnce() {
  const res = await fetch(`/api/pr?pr=${state.pr}${repoQuery}`)
  if (!res.ok) return false
  const meta = await res.json()
  if (!meta || !meta.ok) return false
  state.prMeta = meta
  state.title = meta.title || ''
  if (state.title) {
    document.title = `${state.title} · PR Review Tree`
  }
  state.prUrl = meta.url || ''
  const m = state.title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)
  state.jiraKey = m ? m[1] : ''
  return meta.reviewDecision !== '' || (Array.isArray(meta.reviewers) && meta.reviewers.length > 0) || meta.checksTotal > 0
}

async function pollPRMeta(count) {
  try {
    if (await fetchPRMetaOnce()) return
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
    const res = await fetch(`/api/workflows?pr=${state.pr}${repoQuery}`)
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

const PROBLEMS_POLL_MS = 15000

// pollProblems refreshes state.pageProblems from the read-only, repo-wide GET
// /api/problems (the SAME endpoint the /pr-overview "Mislukte taken" drawer
// reads, see src/problems.mjs) — filtered client-side to this PR, since the
// endpoint itself has no `pr=` filter. A slower cadence than pollWorkflows:
// failures are rare, this is a "did something go wrong out of sight" check,
// not a live status. Best-effort (offline just leaves the last-known list).
async function pollProblems() {
  const { ok, failedRuns, logErrors } = await fetchProblems()
  if (!ok) return
  state.pageProblems = {
    failedRuns: failedRuns.filter((r) => r.pr === state.pr),
    logErrors: logErrors.filter((e) => e.pr === state.pr),
  }
}

// childrenOf returns parent block b's related children as { block, kind, line }
// triples (the blocks it is linked to, e.g. the Listener::handle for an event it
// dispatches, or the controller under a route). The kind is carried through so
// the panel badge names the child's role (listener/controller/request/…). line
// is the absolute source line, within b's own text, where the backend detector
// found this relation's trigger (relations.Relation.Line, see relations.go's
// matchLine) — used by relatedChildren's group-level reordering below.
//
// `r.childId === b.id` (a self-loop edge — the backend detector matching a
// block's own relation trigger back to itself, e.g. a recursive dispatch/call)
// is filtered out here, mirroring the existing `kid.id === parentId` guard in
// nestedChangedKids. Without it the Onderliggende-code panel showed the
// selected block as its OWN child: identical title/file/line, its own code —
// literally a duplicate of the card being viewed. See "Open investigation…" in
// drilling.md (now resolved) and tests/drill-self-loop-relation.spec.mjs.
function childrenOf(b) {
  if (!b || !state.relations || state.relations.length === 0) return []
  return state.relations
    .filter((r) => r.parentId === b.id && r.childId !== b.id)
    .map((r) => {
      const block = state.allBlocks.find((x) => x.id === r.childId)
      return block ? { block, kind: r.kind, line: r.line } : null
    })
    .filter(Boolean)
}

// isBlockLevelCallKey recognizes the synthetic, colon-containing callKey
// prefixes emitted by callresolve rules that deliberately have NO single line
// in the caller to anchor to (see the callresolve_analysis.go doc comments
// for resolveMigrationModels/resolveDataProviders/scanTraits (rule 8, "trait
// usage") and rule 7 "Resource usage" in tembed-workflows.md — all four
// explicitly note their key "never matches a real call-site literal"). Such a
// child is block-level knowledge, not tied to one line/call, and must never
// be scoped away by callScopeMethods/hideOutOfScope just because
// findCallSites can't (and isn't meant to) find a literal site for it —
// including at 'group' granularity, now that that also hard-filters (see
// relatedChildren's own scoping doc): `trait_usage` was added here for
// exactly that reason — before 'group' hid anything, findCallSites silently
// returning no sites for it was harmless (it only ever mattered at 'line'/
// 'call', rarely visited); once 'group' — the DEFAULT granularity on entering
// a diff — started hard-filtering too, that same gap would have made a
// trait-usage child disappear almost always. `translation:` is NOT included
// here — that prefix DOES have a real literal site (the quoted key string
// inside a trans()/__()/@lang() call, matched separately below), so it stays
// properly scoped to the line it's actually used on.
// `class_member:` (a <class-header> block's own declared property/constant, see
// resolveClassMembers in callresolve_analysis.go) is ONLY block-level while the
// caller IS that <class-header> block itself (the no-sibling fallback,
// resolveClassMembers/classSiblingIDs) — there the card's declaration lines
// ARE the header's own diff, so scoping it to one selected group would hide
// exactly the members the reviewer is looking at. Once the card is attached to
// a SIBLING method instead (the common case — see classSiblingIDs), it DOES
// have a real usage site to look for (the member's own name used as a
// property/constant access inside that sibling), so callScopeMethods/
// findCallSites special-case it back OUT of this bypass for that caller —
// see their own doc comments — "alleen zien als het te maken heeft met de
// geselecteerde groep/regel" (Reindert). The `const_ref` rule (6b, a
// Foo::MAX_TRIES reference) is deliberately NOT here at all — its key IS a
// real literal on a real line, like an ordinary call, for every caller.
// `class_ctor:`/`class_method:` (a Foo::class reference's constructor and
// first other method, rule 6c-bis) are DELIBERATELY NOT here (reversed on
// explicit request, 2026-08-17): their key names the CLASS, not a call to the
// method being shown, but the class DOES have a real literal site in the
// caller — the same `Foo::class` reference rule 6c's own `class_ref` child
// (the bare classname) already scopes to. Before this, they stayed visible
// regardless of which call/line the reviewer had selected in the block, which
// read as "this unrelated call resolves to that method" (reported: selecting
// `$request->isPartner()` still showed `CommissionRepository::getAsPartner`
// as "eerste methode", with no relation between the two at all). findCallSites
// now matches the class name against the same `Foo::class` literal instead of
// treating this as block-level, so callScopeMethods scopes them exactly like
// an ordinary call/`class_member:`-on-a-sibling. See
// tests/related-class-ref-entry-points-scope.spec.mjs.
// `class_method:` alone can ALSO originate from rule 2b-bis (a plain
// `new Foo(...)` with no chained call, see workflows-analysis.md) — same
// non-block-level treatment, findCallSites' own `class_ctor:`/`class_method:`
// branch just matches the `Foo(` literal too in that case.
function isBlockLevelCallKey(name) {
  return /^(resource|migration_model|data_provider|trait_usage|class_member):/.test(name)
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
function findCallSites(rows, name, spanArgs = false) {
  const sites = []
  let re
  // `class_member:prop:$name` / `class_member:const:NAME` (resolveClassMembers,
  // see isBlockLevelCallKey's own doc comment): unlike the other four
  // block-level prefixes this ONE has a real usage site to look for once it's
  // attached to a sibling method rather than the <class-header> block itself —
  // the bare member name used as a property access (`->name`, sigil dropped)
  // or a constant/static-property access (`::name`/`::$name`, sigil kept).
  // Matching stays deliberately loose (any receiver before `->`/`::`, like the
  // ordinary method-call regex below) — this is textual, not semantic.
  if (name.startsWith('class_member:')) {
    const raw = name.replace(/^class_member:[^:]*:/, '')
    const isProp = raw.startsWith('$')
    const bare = (isProp ? raw.slice(1) : raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = isProp
      ? new RegExp('->\\s*' + bare + '\\b|::\\s*\\$' + bare + '\\b', 'g')
      : new RegExp('::\\s*' + bare + '\\b', 'g')
  } else if (name.startsWith('class_ctor:') || name.startsWith('class_method:')) {
    // `class_ctor:<Class>` / `class_method:<Class>` (rule 6c-bis, a bare
    // `Foo::class` reference's constructor/first-other-method entry points —
    // AND, for `class_method:` alone, rule 2b-bis's own `new Foo(...)`-with-
    // no-chained-call origin, see workflows-analysis.md): the key names the
    // CLASS, but that class DOES have a real literal site in the caller —
    // either the `Foo::class` reference these cards are entry points for
    // (rule 6c's own `class_ref` child matches the same literal, unprefixed,
    // via the generic branch below), or a plain `new Foo(` construction
    // (rule 2b's own constructor card matches `Foo(` the same way, via that
    // same generic branch). Match BOTH literal forms — a `class_method:` card
    // can originate from either rule, and a block could even carry both a
    // `Foo::class` reference and a separate `new Foo(...)` elsewhere. Scope
    // to wherever either reference actually sits, like an ordinary call —
    // reversed from the earlier "always block-level" exemption (see
    // isBlockLevelCallKey's own doc comment).
    const cls = name.replace(/^(class_ctor|class_method):/, '')
    const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp('\\b' + esc + '\\s*::\\s*class\\b|\\b' + esc + '\\s*\\(', 'g')
  } else if (isBlockLevelCallKey(name)) {
    // A block-level synthetic key (resource:/migration_model:/data_provider:/
    // trait_usage:, see isBlockLevelCallKey) never appears as a literal
    // anywhere in the caller's own text — there is no single call site to
    // find, by design. Return no sites rather than falling into the
    // "isCommand" branch below, which would build a `command('resource:Foo'...)`
    // regex that can never match — callScopeMethods special-cases this key
    // shape to stay in scope regardless, so an empty result here is harmless
    // (only used elsewhere for the "is this call on a changed line" ordering
    // heuristic).
    return sites
  } else {
    // A translation callKey (translation:<locale>:<file.key>, see resolveTranslations)
    // couples via the KEY string literal inside a trans()/__()/@lang()/trans_choice()
    // call — the same literal for every locale, so nl and en children both point at
    // the one call site.
    // An artisan command key (accounting:import, foo-bar) carries characters no PHP
    // identifier has (':', '-'), so it can never be a method/property/enum name — it
    // appears only as the string literal of a ->command('name …') scheduler call.
    // Match that literal instead of the identifier forms.
    const isCommand = /[^\w]/.test(name)
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (name.startsWith('translation:')) {
      const key = name.replace(/^translation:[^:]*:/, '')
      const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // A key resolved from a STATIC literal (resolveTranslations) has that
      // exact string quoted in the caller — matched above. A key resolved by
      // resolveEnumValueTranslations (callresolve_analysis.go) — a static
      // prefix concatenated with a backed enum's own $this->value, e.g.
      // trans('includes.orders.' . $this->value) — has NO literal for the
      // full resolved key at all: only its PREFIX (the key with its last
      // dot-segment, the enum case's own value, stripped back to the
      // trailing dot) is actually quoted in the source. Matching both keeps
      // every ordinary static key scoped exactly as before, and additionally
      // scopes an enum-value-derived child to the one trans()/__() call it
      // came from instead of it being hidden as "out of scope" everywhere.
      const prefix = key.replace(/\.[^.]*$/, '.')
      const escPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      re = escPrefix === escKey ? new RegExp("['\"]" + escKey + "['\"]", 'g') : new RegExp("['\"](?:" + escKey + '|' + escPrefix + ")['\"]", 'g')
    } else if (name.startsWith('config:') || name.startsWith('config_env:')) {
      // config:<file.key.path> / config_env:<file.key.path> (resolveConfigCalls,
      // callresolve_analysis.go): both siblings couple to the SAME literal — the
      // key string inside the caller's own config('file.key.path') call — since
      // the env var name itself never appears in the caller's PHP source at all.
      const escKey = name.replace(/^config(_env)?:/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      re = new RegExp("['\"]" + escKey + "['\"]", 'g')
    } else if (isCommand) {
      re = new RegExp("command\\s*\\(\\s*['\"]" + esc + "(?=[\\s'\"])", 'g')
    } else {
      // `\bname\s*::\s*class\b` is the bare Foo::class literal (rule 6c's
      // class_ref/model_usage-via-::class children, e.g. a Temporal
      // `'activities' => [FooActivity::class, ...]` array entry) — the class
      // name sits BEFORE the `::`, unlike the enum-case `::name` alternative
      // above, so it needs its own branch.
      re = new RegExp(
        '->\\s*' + name + '\\b|::\\s*' + name + '\\b|\\b' + name + '\\s*\\(|\\b' + name + '\\s*::\\s*class\\b',
        'g',
      )
    }
  }
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
      // A call whose argument list runs on over the next rows also "sits on"
      // those rows, for scoping purposes — see argListSites. Only a real
      // call-open match (`name(`, so m[0] ends in the paren) can have one;
      // the `->prop` / `::CASE` / `Foo::class` alternatives never do.
      if (spanArgs && m[0].endsWith('(')) {
        for (const site of argListSites(rows, i, m.index + m[0].length - 1)) sites.push(site)
      }
    }
  }
  return sites
}

// ARG_LIST_MAX_ROWS caps how far argListSites keeps walking. A miscounted
// depth (a `(` inside a block comment — see skipToArgListEnd) would otherwise
// run to the end of the block; a call whose arguments really span more rows
// than this simply stops being widened past the cap, which only ever costs
// visibility, never correctness.
const ARG_LIST_MAX_ROWS = 80

// argListSites lists the rows a multi-line call's argument list CONTINUES onto
// — the rows after `rows[i]`, whose call opens at char `openIdx`, up to and
// including the row closing that paren — as extra sites, one per call segment
// of each such row (so 'call' granularity matches whichever argument segment
// the cursor is on, and 'line'/'group' match the row).
//
// Why: a call site is one row, but a call is not. In
//
//   $instance = new self(
//       sessionId: (string) $state['session_id'],
//   );
//
// the `self` site sits on the `new self(` row only, so selecting just the
// argument line scoped the SessionState::__construct card away — "ik wil bij
// `new ` ook de constructor parameters zien. Die wil ik ook zien als ik
// bijvoorbeeld alleen `sessionId ...` selecteer" (Reindert). Standing inside a
// call's argument list IS standing on that call.
//
// Deliberately only used by callScopeMethods (the cursor→visible-children
// scope, so also unresolvedCalls' automatic search) — NOT by the primary-site
// consumers: lineChildSummaries' per-row avatar+N badge, the call-arrow
// overlay's anchor row and the "does this call sit on a changed row?" ordering
// heuristic all keep pointing at the row carrying the call NAME. Widening
// those would put a badge and an arrow target on every line of a long argument
// list, which is noise, not information.
function argListSites(rows, i, openIdx) {
  const first = rows[i].right
  let depth = skipToArgListEnd(first, openIdx, 0)
  if (depth <= 0) return [] // the call closes on its own row
  const out = []
  const last = Math.min(rows.length - 1, i + ARG_LIST_MAX_ROWS)
  for (let j = i + 1; j <= last; j++) {
    const text = rows[j].right
    if (text == null) continue // an alignment filler row has no new-side text
    for (const seg of rowCallSegments(rows, j)) out.push({ row: j, segStart: seg.start })
    depth = skipToArgListEnd(text, 0, depth)
    if (depth <= 0) break
  }
  return out
}

// skipToArgListEnd counts parens in `text` from char `from`, starting at
// `depth`, and returns the depth left at the end of the row. Quoted strings are
// opaque and a `//` line comment ends the row, mirroring openParenLines in
// callresolve_analysis.go (the Go side of the same "a changed argument line
// belongs to its call" rule). A `#` is NOT treated as a comment here: this runs
// on diff rows whose leading `#[Attribute]` / `#` forms are far more likely
// than a `#` comment inside an argument list, and over-counting is the safer
// failure (see ARG_LIST_MAX_ROWS).
function skipToArgListEnd(text, from, depth) {
  for (let c = from; c < text.length; c++) {
    const ch = text[c]
    if (ch === '"' || ch === "'") {
      for (c++; c < text.length; c++) {
        if (text[c] === '\\') {
          c++
          continue
        }
        if (text[c] === ch) break
      }
    } else if (ch === '/' && text[c + 1] === '/') {
      return depth
    } else if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
      if (depth <= 0) return depth
    }
  }
  return depth
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
  // focusedActiveUnit() resolves the SAME unit activeGroup already highlights
  // — including a merged Shift+arrow range (rangeUnit), at any focusLevel —
  // so a multi-line/multi-group selection widens the Onderliggende-code scope
  // to every call under it, not just the call under the lone cursor row.
  const unit = focusedActiveUnit()
  if (!unit) return null
  const methods = new Set()
  // b's own name decides whether a class_member: key stays block-level (see
  // isBlockLevelCallKey's own doc comment) — only true while b IS the
  // <class-header> block itself (resolveClassMembers' no-sibling fallback).
  const bIsClassHeader = b.name === '<class-header>'
  for (const r of callRows(b)) {
    // A block-level synthetic key (resource:/migration_model:/data_provider:/
    // trait_usage:) has no line to check against — findCallSites deliberately
    // returns no sites for it (see isBlockLevelCallKey) — so treat it as
    // always in scope instead of letting the empty site list read as "not
    // here", which would otherwise make hideOutOfScope filter it out entirely
    // at 'line'/'call' granularity even though its underlying call genuinely
    // sits on the selected line. `class_member:` only gets that same free pass
    // while b is the <class-header> block itself — attached to a SIBLING
    // method it DOES have a real usage site (findCallSites' own class_member
    // branch), so it falls through to the real scoping below like an
    // ordinary call: "alleen zien als het te maken heeft met de geselecteerde
    // groep/regel" (Reindert).
    if (isBlockLevelCallKey(r.callKey) && !(r.callKey.startsWith('class_member:') && !bIsClassHeader)) {
      methods.add(r.callKey)
      continue
    }
    // spanArgs: a multi-line call's own argument rows count as its site too
    // (see argListSites) — selecting only `sessionId: …` inside a
    // `new self(` still shows that constructor.
    const sites = findCallSites(rows, r.callKey, true)
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
// scoping doesn't apply (not diff mode, the focused cursor isn't on gran
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
  // Same merged-range reuse as callScopeMethods — a Shift+arrow selection of
  // several groups widens which relation/testcovers children stay visible to
  // the whole selected range, not just the lone group under the cursor.
  const unit = focusedActiveUnit()
  if (!unit) return null
  const { startLine, endLine, side } = unitLineRange(b, rows, unit)
  if (side !== 'RIGHT' || !startLine) return null
  return { startLine, endLine }
}

// groupTierForLine is the one rule every group-scoping decision in this file
// follows: HIDE ONLY WHAT WE CAN PROVE SITS OUTSIDE THE SELECTED GROUP —
// missing scope information is never itself a reason to hide something. `line`
// is a child's own recorded source line (childrenOf's site line / a `covers`
// row's testcovers.Entry.Line); `range` is groupLineRange's result. Returns 1
// (out of scope, filtered out by relatedChildren) only when BOTH a range is
// active AND the child carries a real (truthy) line that falls outside it;
// returns 0 (kept) in every other case — no active range (list mode, or not
// 'group' granularity), or no line at all. A falsy `line` covers two distinct
// but equally "we don't know" situations: a relation recorded before the
// `line` field existed (relations.Relation.Line's own "0 = legacy row" doc
// comment) and a plain test fixture that never set one (several specs in this
// suite seed a relation with no `line` at all) — both must stay visible rather
// than being read as "line 0, almost certainly outside the range".
function groupTierForLine(range, line) {
  if (!range || !line) return 0
  return line >= range.startLine && line <= range.endLine ? 0 : 1
}

// RE_WHEN_COMMENT/RE_ANY_COMMENT back whenSectionRows below — the codebase's
// Given/When/Then test convention (see .claude/docs/workflows-analysis.md,
// "Linking test coverage"), matched case-insensitively against a row's own
// displayed text (rowAnchorText).
const RE_WHEN_COMMENT = /^\s*\/\/\s*when\b/i
const RE_ANY_COMMENT = /^\s*\/\//

// whenSectionRows scans a TEST block's own aligned rows for every "// When"
// comment and returns the row indices of the STATEMENT lines that follow it
// — never the comment row itself (Reindert, 2026-08-10: "cursor op de
// comment-regel zelf toont de kaart niet") — up to, but not including, the
// next comment row (any "//" line, not only another Given/When/Then marker)
// or a blank row, whichever comes first, or the end of the block. Repeated
// for every "// When" occurrence in the block (a test can have more than
// one — e.g. several Given/When/Then cycles in one method), unioned into one
// Set.
//
// Used by resolvedTestCoverChildren/lineChildSummaries as the scope for a
// `covers` target with no single natural anchor line of its own
// (testcovers.Entry.Line === 0 — either an LLM `found` row escalated from a
// class-only annotation, or a Go-`resolved` row whose #[CoversMethod]/
// #[CoversClass] sits above the CLASS rather than this one test method, see
// testcovers_analysis.go's coverTargets/classZoneText fallback): the test's
// own action-under-test is the closest thing that target has to "its own
// line", closer than "visible on every line" (the previous, too-permissive
// fallback) or a coincidentally wrong single line (the bug fixed in
// 121be8d).
function whenSectionRows(rows) {
  const out = new Set()
  for (let i = 0; i < rows.length; i++) {
    if (!RE_WHEN_COMMENT.test(rowAnchorText(rows[i]))) continue
    for (let j = i + 1; j < rows.length; j++) {
      const text = rowAnchorText(rows[j])
      if (text.trim() === '' || RE_ANY_COMMENT.test(text)) break
      out.add(j)
    }
  }
  return out
}

// groupUnitRowRange mirrors groupLineRange's own guards (diff mode, b is the
// focused block, gran==='group', a Shift-merged range widens it) but returns
// the row-index range { start, end } of the selected unit directly, instead
// of converting to absolute source lines — whenSectionRows above already
// works in row space (the very same `rows` array), so no line round-trip is
// needed for that comparison.
function groupUnitRowRange(b) {
  if (state.mode !== 'diff') return null
  if (b !== focusedBlock()) return null
  const cur = focusedGranCursor()
  if (cur.gran !== 'group') return null
  const unit = focusedActiveUnit()
  if (!unit) return null
  return { start: unit.start, end: unit.end }
}

// testCoverGroupTier is resolvedTestCoverChildren's own groupTier rule: a row
// with a real recorded line goes through the ordinary groupTierForLine; a row
// with none (r.line === 0) falls back to whenSectionRows scoping instead of
// groupTierForLine's blanket "no information ⇒ never hide" — see
// whenSectionRows' own doc comment for why. `range` truthy is reused as the
// "group-diff-mode scoping is actually active right now" guard (the exact
// condition groupUnitRowRange itself re-checks) — outside that (list mode, or
// not 'group' granularity), stay permissive like every other exemption here.
function testCoverGroupTier(b, rows, range, line) {
  if (line) return groupTierForLine(range, line)
  if (!range) return 0
  const whenRows = whenSectionRows(rows)
  if (whenRows.size === 0) return 0 // no "// When" found at all — no info, don't hide
  const unitRows = groupUnitRowRange(b)
  if (!unitRows) return 0
  for (let i = unitRows.start; i <= unitRows.end; i++) {
    if (whenRows.has(i)) return 0
  }
  return 1
}

// lineAnchoredTestCoverChildren — the ONE exception to "'line'/'call' scoping
// drops every covers child outright" (relatedChildren's `scoped` flag below):
// at gran==='line', a covers child whose own ANCHOR ROW is the selected row
// stays visible. Reported by the reviewer as a contradiction on one and the
// same row (live PR 13431, the `getJson(...)` line of
// StatisticsActivitiesIndexTest::it_gives_amount_obligation_…): the row's own
// per-line badge (lineChildSummaries, the "✓ 2/2" pill) promised underlying
// code there, while stepping onto that very line with `d` made the panel say
// "Geen onderliggende code." — the badge and the panel disagreed about the
// same child.
//
// The anchor is resolved with the IDENTICAL rule lineChildSummaries uses for
// the badge, so the two can't drift apart again: a row with a real recorded
// line (testcovers.Entry.Line truthy) anchors on newLineToRowOf(line); a row
// with none (Line === 0 — a class-level #[CoversMethod]/found-escalated row,
// see "A class-level #[CoversMethod]/found-escalated covers child scopes to
// `// When`" in .claude/docs/underlying-code.md) anchors on the covering
// test's own `// When` statement rows (whenSectionRows).
//
// Deliberately gran==='line' only, NOT 'call': a call segment is FINER than a
// row (see keyboard-navigation.md's f/d/s chain), and a covers target isn't
// the target of that one call — at 'call' the panel keeps showing the call's
// own resolved method and nothing else, unchanged.
function lineAnchoredTestCoverChildren(b, rows, range) {
  if (focusedGranCursor().gran !== 'line') return []
  const unit = focusedActiveUnit()
  if (!unit) return []
  const inUnit = (row) => row != null && row >= unit.start && row <= unit.end
  const whenRows = whenSectionRows(rows)
  const onWhenRow = () => {
    for (let i = unit.start; i <= unit.end; i++) if (whenRows.has(i)) return true
    return false
  }
  return resolvedTestCoverChildren(b, range, (r) =>
    r.line ? inUnit(newLineToRowOf(rows, r.line)) : onWhenRow(),
  )
}

// relatedChildren describes the selected block's children for the RelatedPanel:
// the resolved method calls it makes (coupled to the call in the diff) plus the
// event listeners it is linked to. It lazily loads any child block's code and
// returns a small descriptor per child. Reactive — reading state.selected/mode/
// gran/change/relations/callResolve + each child's code — so the panel follows
// the cursor and re-renders as child code arrives.
//
// Scoping by the reviewer's current selection, from finest to coarsest
// granularity — 'call'/'line'/'group' now all HIDE a child outright that
// falls outside the active unit, per groupTierForLine's rule above:
//  - 'call'/'line': only children whose site sits under the active call/line
//    remain (see callScopeMethods for method-call children; a relation child
//    has no site *within* that fine a unit at all, so it drops out entirely —
//    "onderliggende code van die line/call", not the whole block's). ONE
//    exception, at 'line' only: a covers child whose own anchor ROW is the
//    selected row stays visible, resolved with the exact same anchoring rule
//    the per-line badge uses — see lineAnchoredTestCoverChildren above for
//    the reported badge-vs-panel contradiction that closed.
//  - 'group': a child whose site (childrenOf's line / a `covers` row's
//    testcovers.Entry.Line) falls inside the selected group's line range is
//    kept (groupTier 0); one that falls OUTSIDE it is now HIDDEN too
//    (groupTier 1, filtered below) — no longer merely sorted last. THREE
//    deliberate exemptions, all following from groupTierForLine's "no
//    information ⇒ don't hide" rule:
//      1. a block-level synthetic callKey (resource:/migration_model:/
//         data_provider:/trait_usage:, see isBlockLevelCallKey) has no site to
//         compare at all — always kept, exactly as at line/call.
//      2. `covered_by` (the covering test — direction 2, see
//         coveredByChildren) never carries a site of its own: the annotation
//         lives in the TEST's file, not b's. Reindert chose explicitly to
//         keep it exempt (always shown, regardless of the selected group) —
//         a hard filter here would make "covered by TestX::testY" disappear
//         almost every time the reviewer is in diff mode (group is the
//         default granularity), which is too much loss for too little gain.
//      3. a relation/covers child with no recorded line at all (see
//         groupTierForLine's own doc comment) — kept, never treated as "line
//         0 is out of range".
//    `translation:` children are NOT exempt — that callKey couples to a real
//    string-literal site (see isBlockLevelCallKey's own doc comment), so it
//    stays properly, hard-scoped to the line it's actually used on, like an
//    ordinary method call.
//  - No active unit (list mode, or gran isn't 'group'/'line'/'call'): nothing
//    is filtered — groupLineRange/callScopeMethods return null, so
//    groupTierForLine's own `!range` guard keeps everyone at tier 0.
// Comment threads (InlineComments/commentUnder, RelatedPanel.mjs) already hard
// -filter by row range at every granularity, including 'group' — they needed
// no change for this.
// codeSize counts the non-blank lines of a child's source — a rough "how much
// code changed here" measure used to order same-priority children in the
// Onderliggende-code panel (substantial methods above one-line accessors).
function codeSize(code) {
  if (!code) return 0
  return code.split('\n').filter((l) => l.trim()).length
}

function relatedChildren(b) {
  // The hide-scoping at every granularity (line/call/group alike) only applies
  // to whichever column currently owns the keyboard — the top-level selected
  // block OR the focused drilled column, using ITS OWN drillCursor entry
  // (focusedGranCursor) — never a block that isn't focused right now (see
  // callScopeMethods/groupLineRange, which resolve the same cursor).
  const isFocusedCursor = b === focusedBlock()
  const scoped =
    isFocusedCursor && state.mode === 'diff' && (focusedGranCursor().gran === 'call' || focusedGranCursor().gran === 'line')
  const rows = blockRows(b)
  const range = isFocusedCursor ? groupLineRange(b, rows) : null
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
          // The child's own PR-block category (ACTION/CONTROLLER/…, see
          // classify.go) — always available here since a relation child is by
          // definition a real, both-changed PR block. Empty falls back to
          // "OTHER" in the panel, mirroring the top-level block card.
          category: kid.category || '',
          code,
          // True only while the lazy /api/code fetch is still in flight
          // (ensureCode sets kid.code to an object — even { error } — once it
          // completes). Lets the panel tell "code laden…" apart from a finished
          // load that turned out empty ("geen code gevonden").
          loading: !kid.code,
          size: codeSize(code),
          prio: 0,
          // pending is subtree-wide (subtreeApproveCount, not blockApproveCount):
          // a card whose own rows are done but that still has an unapproved
          // nested chip underneath (e.g. SessionState::remember at 7/7 with an
          // unapproved SessionState::carry) must still sort/land as "not done" —
          // see "pending sorts first" in .claude/docs/underlying-code.md.
          pending: (() => {
            const c = subtreeApproveCount(kid)
            return c.done < c.total
          })(),
          approve: blockApproveCount(kid),
          // Same "open comment somewhere in this block's own subtree"
          // indicator as the sidebar pill (commentActivityPill,
          // BlockList.mjs), now also surfaced per Onderliggende-code child —
          // a relation child is by definition a real PR block, so its own
          // subtree can be rolled up exactly like a top-level row's.
          commentActivity: commentActivitySummary(commentScopeKeys(kid)),
          groupTier: groupTierForLine(range, siteLine),
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
  const covers = scoped
    ? lineAnchoredTestCoverChildren(b, rows, range)
    : resolvedTestCoverChildren(b, range)
  const coveredBy = scoped ? [] : coveredByChildren(b)
  // Sort by groupTier first (see the scoping doc above), then whether the
  // child still has ANY approval work pending anywhere in its own subtree
  // (`pending`, computed per branch above via subtreeApproveCount — not just
  // the card's own rows: SessionState::remember can read 7/7 on its own rows
  // and still carry an unapproved SessionState::carry underneath, and that
  // still has to sort/land first). Reviewer request: "laat de blok bovenaan
  // zien die nog niet zijn goedgekeurd" — Space already walks to the first
  // unapproved unit depth-first (findNextUnapproved), so this makes the
  // panel's own top-to-bottom order agree with where Space actually lands.
  // Only THEN priority (0 = also-changed child block, 1 = call on a changed
  // line, 2 = unchanged call), then — within a priority — biggest child
  // first, so the substantial modified code the reviewer cares about leads
  // while trivial one-liners (e.g. Eloquent relation accessors, which are
  // also `added` PR blocks and thus tie at prio 0) drop below it. `size` is
  // the child's line count (embedded childCode for calls, loaded code for
  // listeners); a child whose code hasn't arrived yet is size 0 and sinks
  // until it loads. Ties keep the resolver-emit (source) order
  // (Array.prototype.sort is stable).
  let sorted = evt
    .concat(covers)
    .concat(coveredBy)
    .concat(calls)
    .sort(
      (x, y) =>
        (x.groupTier || 0) - (y.groupTier || 0) ||
        (x.pending ? 0 : 1) - (y.pending ? 0 : 1) ||
        x.prio - y.prio ||
        y.size - x.size,
    )
  // 'group'-diff-mode HARD FILTER: drop anything groupTierForLine scored as
  // out-of-range (see relatedChildren's own scoping doc above). Only applies
  // while `range` is actually active — outside that (list mode, or a
  // non-'group' granularity, where the call/line hiding above already ran)
  // every groupTier is a no-op 0, so this filter is itself a no-op there.
  if (range) sorted = sorted.filter((c) => (c.groupTier || 0) === 0)
  sorted = interleaveTranslationSiblings(sorted)
  return groupTestChildren(b, sorted)
}

// interleaveTranslationSiblings makes the translation children (kind:
// 'translation', one per locale of the same key, see resolvedCallChildren)
// of the SAME transKey sit ADJACENT in the list — the resolver/sort above
// emits them grouped by locale instead (every 'en' key, then every 'nl' key),
// which used to read fine as a flat vertical stack but is wrong once
// RelatedPanel renders same-key siblings side by side (see
// .claude/docs/underlying-code.md, "Translation children: en/nl paired side
// by side"): the panel cursor (cs.codeSel) walks this SAME array in order, so
// the visual left/right pairing must match ↓/↑'s own order, or stepping past
// the last 'en' card would jump to a DIFFERENT row's 'nl' card instead of the
// one drawn right next to it. Groups by transKey, keeping the first-seen key
// order; within a group 'en' sorts first, the rest alphabetically by locale
// (stable otherwise). A no-op (returns `sorted` unchanged) whenever there are
// fewer than 2 translation children, or none at all.
function interleaveTranslationSiblings(sorted) {
  const transIdx = []
  for (let i = 0; i < sorted.length; i++) if (sorted[i].kind === 'translation') transIdx.push(i)
  if (transIdx.length < 2) return sorted
  const byKey = new Map()
  for (const i of transIdx) {
    const c = sorted[i]
    if (!byKey.has(c.transKey)) byKey.set(c.transKey, [])
    byKey.get(c.transKey).push(c)
  }
  const ordered = []
  for (const items of byKey.values()) {
    items.sort((a, b) => {
      if (a.locale === 'en' && b.locale !== 'en') return -1
      if (b.locale === 'en' && a.locale !== 'en') return 1
      return (a.locale || '').localeCompare(b.locale || '')
    })
    ordered.push(...items)
  }
  const result = []
  let spliced = false
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].kind === 'translation') {
      if (!spliced) {
        result.push(...ordered)
        spliced = true
      }
    } else {
      result.push(sorted[i])
    }
  }
  return result
}

// groupTestChildren collapses the covering tests (kind covered_by — the tests
// that cover this production block) into ONE horizontal "tests bar" descriptor
// when the panel ALSO shows other (non-test) children, so the tests don't push
// the actual underlying code down the list. Clicking/Enter on the bar toggles
// state.testsExpanded (both land in drillIntoChild, which branches on the
// kind); expanded, the test cards render as ordinary children directly below
// the bar, which stays put as the collapse toggle. With no other children (or
// no tests at all) this is a no-op — the tests render as plain cards, exactly
// as before. The bar rides along IN the children list itself (always LAST,
// below every other child — reviewer request: the bar used to take the slot
// of the first test in the sorted order, which could land it above code
// cards), so the panel cursor stays 1:1 with the visible rows (cs.codeSel
// indexes rc.children) without any special casing in RelatedPanel's keyboard
// walk.
function groupTestChildren(b, sorted) {
  const tests = sorted.filter((c) => c.kind === 'covered_by')
  if (tests.length === 0 || tests.length === sorted.length) return sorted
  const others = sorted.filter((c) => c.kind !== 'covered_by')
  const group = {
    id: 'tests-group:' + b.id,
    kind: 'tests_group',
    count: tests.length,
    tests,
    expanded: state.testsExpanded,
  }
  return others.concat([group], state.testsExpanded ? tests : [])
}

// CLASS_MEMBER_KINDS are the callresolve kinds whose child is a single declared
// class member (a property or a constant) rather than a callable definition —
// see resolveClassMembers (a <class-header> block's own members) and rule 6b (a
// Foo::MAX_TRIES reference) in callresolve_analysis.go. They render as read-only
// leaf cards; see the branch in resolvedCallChildren.
const CLASS_MEMBER_KINDS = new Set(['class_property', 'class_constant_changed', 'class_constant', 'const_ref'])

// resolvedCallChildren maps the caller block's resolved/found call rows to child
// descriptors for the Onderliggende-code panel — tagged with an ordering
// priority, and HIDDEN outright at every diff granularity ('call'/'line'/
// 'group' alike, see callScopeMethods) whose active unit doesn't cover the
// call's own site — `groupTier` below is now purely cosmetic tie-breaking for
// the (already-filtered) survivors, not a hide/show decision. `source` names
// the LLM model when it was resolved by one (status found); Go-resolved rows
// leave it empty.
function resolvedCallChildren(b) {
  if (!b) return []
  const resolved = preferredCallRows(b).filter((r) => r.status === 'resolved' || r.status === 'found')
  if (resolved.length === 0) return []
  const rows = blockRows(b)
  const scope = callScopeMethods(b, rows)
  // callScopeMethods scopes at every diff granularity (group/line/call) — see
  // its own doc comment. scope is only ever non-null when b === focusedBlock()
  // and a unit resolves (callScopeMethods' own guards), so hideOutOfScope is
  // effectively "was a scope actually computed" — kept as its own named flag
  // for readability at the two call sites below, not because it can now ever
  // differ from `state.mode === 'diff'`.
  const hideOutOfScope = state.mode === 'diff'
  const byId = allBlocksById()
  const changed = new Set(changedRows(rows))
  return resolved
    .filter((r) => scope == null || !hideOutOfScope || scope.has(r.callKey))
    .map((r) => {
      // A translation child (a trans()/__()/@lang() key → its lang file, one per
      // locale) is always a leaf value view — never a drillable PR block. It
      // shows the CURRENT value of the key in that locale (translationValueView
      // in RelatedPanel), so it carries no diff/approval/nested chips. callKey is
      // translation:<locale>:<file.key>; the key + locale drive the render.
      if (r.kind === 'translation') {
        const locale = r.childClass || ''
        const key = r.callKey.replace(/^translation:[^:]*:/, '')
        return {
          id: b.id + '::' + r.callKey,
          blockId: '',
          label: locale ? `${locale} · ${key}` : key,
          file: r.childFile,
          line: r.childLine,
          kind: 'translation',
          transKey: key,
          locale,
          category: '',
          code: r.childCode || '',
          loading: false,
          size: codeSize(r.childCode || ''),
          source: '',
          approve: null,
          commentActivity: null,
          diff: null,
          prio: 2,
          // Never a PR block, never anything to approve — always "done" for
          // pending-first sort purposes.
          pending: false,
          groupTier: scope == null || hideOutOfScope ? 0 : scope.has(r.callKey) ? 0 : 1,
          nested: [],
          nestedSig: nestedSigOf([]),
        }
      }
      // A config('file.key.path') child (resolveConfigCalls, callresolve_analysis.go)
      // and its optional .env.example sibling are, like a translation child,
      // always read-only leaves — never a drillable PR block, no diff/approval/
      // nested chips. callKey is config:<key> / config_env:<key>; the env sibling
      // shares the same key (only the kind/prefix differs, see UpsertGo's PK).
      if (r.kind === 'config_value' || r.kind === 'env_example') {
        const key = r.callKey.replace(/^config(_env)?:/, '')
        return {
          id: b.id + '::' + r.callKey,
          blockId: '',
          label: r.kind === 'env_example' ? `.env.example · ${r.childMethod}` : key,
          file: r.childFile,
          line: r.childLine,
          kind: r.kind,
          category: '',
          code: r.childCode || '',
          loading: false,
          size: codeSize(r.childCode || ''),
          source: '',
          approve: null,
          commentActivity: null,
          diff: null,
          prio: 2,
          pending: false,
          groupTier: scope == null || hideOutOfScope ? 0 : scope.has(r.callKey) ? 0 : 1,
          nested: [],
          nestedSig: nestedSigOf([]),
        }
      }
      // A class-member child — a class's own declared property/constant
      // (resolveClassMembers), or a Foo::MAX_TRIES reference resolved to its
      // declaration (rule 6b) — is a read-only leaf ONLY while it is not a PR
      // block: no diff-stat, no approval, no drill-hint chips, no row of its
      // own in the index. A member this PR CHANGED is a block since
      // splitClassHeaderMembers (phpscan.go), so it falls through to the
      // ordinary call-target branch below and gets its real diff, approval and
      // drill-down — which is what makes "elke member een eigen, los goed te
      // keuren blok" reachable from the method that uses it. A changed member
      // sorts above the reference material (prio 0 vs 2).
      if (CLASS_MEMBER_KINDS.has(r.kind) && !byId.get(callChildId(r))) {
        const memberChanged = r.kind === 'class_property' || r.kind === 'class_constant_changed'
        return {
          id: b.id + '::' + r.callKey,
          blockId: '',
          label: r.childClass ? `${r.childClass}::${r.childMethod}` : r.childMethod || r.callKey,
          file: r.childFile,
          line: r.childLine,
          kind: r.kind,
          category: '',
          code: r.childCode || '',
          loading: false,
          size: codeSize(r.childCode || ''),
          source: '',
          approve: null,
          commentActivity: null,
          diff: null,
          prio: memberChanged ? 0 : 2,
          // Not a PR block (the `!byId.get(...)` guard above), so nothing to
          // approve here either way.
          pending: false,
          groupTier: scope == null || hideOutOfScope ? 0 : scope.has(r.callKey) ? 0 : 1,
          nested: [],
          nestedSig: nestedSigOf([]),
        }
      }
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
        // template below (see .claude/docs/tembed-workflows.md).
        label: r.childMethod
          ? `${r.childClass}::${r.childMethod}`
          : r.childClass || r.callKey,
        file: r.childFile,
        line: r.childLine,
        kind: r.kind || 'method_call',
        // Only a call whose definition is itself a PR block (prBlock) carries
        // a real category — an unchanged/synthetic call target was never
        // scanned into a block at all, so there's nothing to read. Empty
        // falls back to "OTHER" in the panel, like the top-level block card.
        category: prBlock ? prBlock.category || '' : '',
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
        // Subtree-wide, like the evt branch above — an unchanged/synthetic
        // target has no subtree, so nothing pending there.
        pending: prBlock
          ? (() => {
              const c = subtreeApproveCount(prBlock)
              return c.done < c.total
            })()
          : false,
        // Same subtree rollup as the sidebar's commentActivityPill, only for a
        // call whose definition is itself a PR block — an unchanged/synthetic
        // target has no subtree to roll up.
        commentActivity: prBlock ? commentActivitySummary(commentScopeKeys(prBlock)) : null,
        // Added/removed line counts of the called definition, shown instead of an
        // "aanroep" badge. null → the call targets an unchanged file (no diff) →
        // renders a grey "Ongewijzigd" badge. Fills in as prBlock's code loads.
        diff: prBlock ? diffStat(blockRows(prBlock)) : null,
        // 0 = the called method is itself changed in this PR (a real child block),
        // 1 = the call sits on a changed line, 2 = an unchanged call. Drives the
        // panel ordering (see relatedChildren).
        prio: prBlock ? 0 : onChangedLine ? 1 : 2,
        // Purely cosmetic tie-breaking at this point — the `.filter` above
        // already dropped any out-of-scope call at every granularity, so a
        // surviving row here is always tier 0 (scope.has(r.callKey) is true
        // whenever hideOutOfScope actually applied).
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
// (resolvedCallChildren's hideOutOfScope) at EVERY granularity, including
// 'group' — the panel now hides an out-of-active-unit call child there too
// (see relatedChildren's own scoping doc), so the arrow must do the same: no
// fallback to "the child's first known call site anywhere in the block" for a
// group whose actual call site sits elsewhere — a card the panel no longer
// shows must never still receive an arrow. One pair per child, diff mode
// only, for whichever column currently owns the keyboard — the top-level
// selected block (focusLevel 0) OR the focused drilled column (focusLevel > 0,
// using ITS OWN state.drillCursor[level-1] cursor, not the top-level
// state.gran/change) — mirroring approveContext()'s own top-level/drilled
// split. Every drilled column is a full navigable diff with its own cursor
// (see "Kolom-navigatie" in detail-layout.md), so there's no reason for the
// arrow to go dark just because the reviewer drilled in; callArrows.mjs' DOM
// lookup (main.querySelector('[data-pane="new"]')/panel.querySelector('[data-
// child-id]')) already resolves to whichever column is focused — a
// non-focused column (top-level or drilled) always collapses to a railless
// rail with no [data-pane] — so no change is needed there. Called from the
// setRelated watch CALLBACK (untracked) — never from a render binding, so it
// can't co-subscribe on b.code with the diff render (conventions.md); b is
// always focusedBlock() (the watch's own `b`), so the guard below is a
// defensive self-check, not a new dependency.
function callArrowPairs(b) {
  if (!b || state.mode !== 'diff' || b !== focusedBlock()) return []
  const level = state.focusLevel
  const cur = level > 0 ? state.drillCursor[level - 1] || { change: 0, gran: 'group' } : { gran: state.gran, change: state.change }
  const rows = blockRows(b)
  const unit = navUnitsOf(b, rows, cur.gran)[cur.change]
  if (!unit) return []
  const byId = allBlocksById()
  const pairs = []
  // preferredCallRows, not callRows: the panel deduplicates two rows pointing at
  // the same definition down to one card, and an arrow must never target a card
  // that is no longer rendered.
  for (const r of preferredCallRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    if (!byId.has(callChildId(r))) continue // only a changed target (a real PR block)
    const sites = findCallSites(rows, r.callKey)
    const site =
      cur.gran === 'call'
        ? sites.find((s) => s.row === unit.start && s.segStart === unit.segStart)
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
  if (!b || !state.callResolve) return NO_ROWS
  return callResolveByCallerId().get(b.id) || NO_ROWS
}

// callTargetKey identifies the DEFINITION a resolved/found call row points at
// (file + class + method) — the same target two differently-keyed rows of one
// caller can share. Empty for a row with nothing to point at (unresolved, or a
// class-level row without a method), which preferredCallRows reads as "never
// deduplicate this one".
function callTargetKey(r) {
  if (!r.childFile || !r.childMethod) return ''
  return r.childFile + '::' + (r.childClass || '') + '::' + r.childMethod
}

// callRowRank orders two rows of the SAME caller that resolve to the SAME
// target, lowest wins (see preferredCallRows):
//   0 — a real Go-resolved call (the call key IS the literal in the source, so
//       it scopes to the actual call segment and carries the call arrow);
//   1 — a Go-resolved synthetic entry point (rule 6c-bis's class_ctor/
//       class_first_method, keyed to the `Foo::class` literal instead);
//   2 — an LLM-found row (status 'found'): deterministic Go resolution wins over
//       a model's, on explicit request.
function callRowRank(r) {
  if (r.status === 'found') return 2
  if (r.kind === 'class_ctor' || r.kind === 'class_first_method') return 1
  return 0
}

// preferredCallRows is callRows minus the rows that would render a SECOND,
// identical Onderliggende-code card: whenever several resolved/found rows of one
// caller point at the very same definition, only the best-ranked one survives
// (callRowRank). Real case: `app(Foo::class)->run()` yields both rule 6c-bis's
// `class_method:Foo` entry point AND a `run` row for the call itself, both
// landing on Foo::run — the reviewer saw the same card twice, once badged
// "eerste method" and once "bron: haiku" (PR 13392). Go's own rule 4a now
// resolves that receiver deterministically so no LLM row is even requested, but
// this stays as the general safety net: it also cleans up PRs ingested BEFORE
// that rule existed, and it is what drops the entry-point row that still
// duplicates the real call.
//
// Used by resolvedCallChildren (the cards) and callArrowPairs (the arrows) —
// deliberately BOTH, since an arrow must never point at a card the panel no
// longer renders. Every other callRows consumer already collapses its rows onto
// the target block id via a Set/Map (directChildBlocks, lineChildSummaries,
// resolvedCallTargetIds, firstUnapprovedCallSiteInUnit, referenceRows), so a
// duplicate row is harmless there and their raw view stays intact.
function preferredCallRows(b) {
  const rows = callRows(b)
  if (rows.length < 2) return rows
  const best = new Map()
  for (const r of rows) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    const key = callTargetKey(r)
    if (!key) continue
    const cur = best.get(key)
    if (!cur || callRowRank(r) < callRowRank(cur)) best.set(key, r)
  }
  let dropped = false
  const kept = rows.filter((r) => {
    if (r.status !== 'resolved' && r.status !== 'found') return true
    const key = callTargetKey(r)
    if (!key) return true
    if (best.get(key) === r) return true
    dropped = true
    return false
  })
  // Same array identity when nothing was deduplicated — the common case.
  return dropped ? kept : rows
}

// blockIdPrefix is the "<pr>" (primary repo) or "<repo-key>#<pr>" prefix every
// block id of THIS page carries — see Block.ID in model.go. The repo KEY is a
// server-side notion (settings.json), so it is not derived here but read off a
// loaded block's own id: everything before the first ":" is exactly that prefix.
// Falls back to the bare PR number, which is the primary repo's form, before any
// block is loaded.
// blockIdPrefix mirrors the repo prefix a real PR block's id carries
// ("<pr>" for the primary repo, "<key>#<pr>" otherwise — see model.go's
// Block.ID) by copying it off an existing real block, since state.pr alone
// doesn't know a non-primary repo's key. Deliberately reads state.allBlocks
// (real PR blocks only, from loadBlocks) rather than state.blocks: the
// latter's [0] can be a SYNTHETIC row — a test_class group
// (testClassRowItem/groupTestClasses, id "testclass:...") or a comment-index
// item (commentBlockItem, id "comment:...") — whenever one sorts to the top
// (recomputeLeftList's rank). Reading state.blocks[0] produced a feedback
// loop: a synthetic-row prefix breaks testCallTargetIds'/
// resolvedCallTargetIds' childId reconstruction for THIS call, which
// reclassifies the target block back onto its own top-level row, which
// changes the sort so a real block becomes state.blocks[0] again next time —
// oscillating once per recomputeLeftList() call (e.g. every ~5s off
// RelatedPanel.mjs's comment-poll indexComments() watch), which read as the
// whole sidebar reordering itself on its own every few seconds. Reported bug,
// reproduced live via a Playwright route-intercepted instrumented build.
function blockIdPrefix() {
  const b = state.allBlocks && state.allBlocks[0]
  if (b && typeof b.id === 'string') {
    const i = b.id.indexOf(':')
    if (i > 0) return b.id.slice(0, i)
  }
  return String(state.pr)
}

// callChildId builds the PR-block id a call-resolution row points at (empty
// class → free function). Matches the id scheme in model.go (Block.ID).
function callChildId(r) {
  return (
    blockIdPrefix() + ':' + r.childFile + ':' + (r.childClass ? r.childClass + '::' + r.childMethod : r.childMethod)
  )
}

// testCoverRows returns the test-coverage rows whose test is block b.
function testCoverRows(b) {
  if (!b || !state.testCovers) return NO_ROWS
  return testCoversByTestId().get(b.id) || NO_ROWS
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
// mode) scores each row's groupTier via testCoverGroupTier: r.line is the
// absolute line — within b's own test file — the annotation sits on
// (testcovers.Entry.Line, only ever set on a Go-resolved row whose annotation
// sits directly above THIS test method, see modules/testcovers/testcovers.go).
// A row with no such line (an LLM-`found` row escalated from a class-only
// annotation, or a Go-`resolved` row whose #[CoversMethod]/#[CoversClass]
// sits above the class instead) falls back to testCoverGroupTier's
// whenSectionRows scoping — see that function's own doc comment.
function resolvedTestCoverChildren(b, range, rowFilter = null) {
  if (!b) return []
  const resolved = testCoverRows(b).filter(
    // rowFilter — only ever passed by lineAnchoredTestCoverChildren above, to
    // keep the one covers row whose anchor is the selected LINE; absent (every
    // other caller) means no extra filtering, exactly as before.
    (r) => (r.status === 'resolved' || r.status === 'found') && (!rowFilter || rowFilter(r)),
  )
  if (resolved.length === 0) return []
  const rows = blockRows(b)
  const byId = allBlocksById()
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
      // Same rule as resolvedCallChildren: only present when the covered
      // method is itself a PR block; empty otherwise → "OTHER" fallback.
      category: prBlock ? prBlock.category || '' : '',
      code: r.coveredCode || '',
      // Embedded in the testcovers row (no lazy fetch) — empty means final,
      // mirroring resolvedCallChildren.
      loading: false,
      size: codeSize(r.coveredCode || ''),
      source: r.status === 'found' ? r.model : '',
      approve: prBlock ? blockApproveCount(prBlock) : null,
      pending: prBlock
        ? (() => {
            const c = subtreeApproveCount(prBlock)
            return c.done < c.total
          })()
        : false,
      commentActivity: prBlock ? commentActivitySummary(commentScopeKeys(prBlock)) : null,
      diff: prBlock ? diffStat(blockRows(prBlock)) : null,
      // A covered method isn't tied to a specific diff line the way a method
      // call is (the annotation covers the whole test), so there's no
      // "on a changed line" middle tier — just changed-in-this-PR (0) or not (2).
      prio: prBlock ? 0 : 2,
      groupTier: testCoverGroupTier(b, rows, range, r.line),
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
// site within b to compare against a group's line range at all — per
// groupTierForLine's "no information ⇒ don't hide" rule this would already be
// exempt (groupTier 0) for lack of a `line`. It's made explicit here rather
// than threading `range` through: Reindert chose deliberately to keep
// "covered by TestX::testY" ALWAYS visible, regardless of which group is
// selected — a hard filter here would make it disappear almost every time the
// reviewer is in diff mode (since 'group' is the default granularity on
// entering a diff), which is too much loss for too little gain.
function coveredByChildren(b) {
  if (!b || !state.testCovers) return []
  const byId = allBlocksById()
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
      // The covering test is always a real PR block (a test_covers row only
      // exists for a test this PR changed), so its category is always known.
      category: test.category || '',
      code,
      // Lazy PR-block code, same rule as the relation children above: loading
      // only while ensureCode's fetch is still in flight.
      loading: !test.code,
      size: codeSize(code),
      source: r.status === 'found' ? r.model : '',
      approve: blockApproveCount(test),
      pending: (() => {
        const sc = subtreeApproveCount(test)
        return sc.done < sc.total
      })(),
      commentActivity: commentActivitySummary(commentScopeKeys(test)),
      diff: diffStat(blockRows(test)),
      prio: 0,
      // No site within b to compare against a group's line range at all —
      // deliberately exempt from group scoping, always tier 0. See this
      // function's own doc comment.
      groupTier: 0,
      nested,
      nestedSig: nestedSigOf(nested),
    })
  }
  return out
}

// unresolvedTestCovers returns block b's test-coverage targets the Go analyzer
// could not resolve statically (status unresolved) plus any currently
// searching — feeding the automatic LLM search and, for `searching`, the
// "zoeken…" pill, mirroring unresolvedCalls.
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
        repo: state.repo || undefined,
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
  const byId = allBlocksById()
  const ids = new Set()
  for (const r of relationsByParentId().get(b.id) || NO_ROWS) ids.add(r.childId)
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
  // Same pending-first rule as relatedChildren's own sort (subtree-wide, via
  // subtreeApproveCount): a still-open chip must lead, not sit behind a
  // fully-approved sibling chip.
  const kids = [...directChildBlocks(prBlock)].sort((x, y) => {
    const cx = subtreeApproveCount(x)
    const cy = subtreeApproveCount(y)
    const px = cx.done < cx.total ? 0 : 1
    const py = cy.done < cy.total ? 0 : 1
    return px - py
  })
  for (const kid of kids) {
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
      // A chip target is always a real PR block (directChildBlocks only
      // returns those), so its category is always known — carried along for
      // parity with the other descriptor builders, even though the chip's
      // own compact layout (RelatedPanel.mjs' nestedChip) doesn't render it.
      category: kid.category || '',
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

// nestedPrBlocksCached memoizes a genuine TOP-LEVEL nestedPrBlocks(b) call
// (fresh seen=new Set(), i.e. b's own full transitive closure) keyed by
// b.id, invalidated by reference identity of state.allBlocks/relations/
// callResolve/testCovers — same shape and same exact invalidation check as
// allBlocksById/relationsByParentId/callResolveByCallerId/testCoversByTestId
// above, safe for the same reason: nestedPrBlocks' result depends only on
// the directChildBlocks graph (those four arrays), never on per-block
// approval state. Deliberately only wraps the TOP call, never the internal
// recursive `nestedPrBlocks(kid, seen)` above (which threads an explicit,
// shared `seen` and must keep its exact per-call cycle/dedup semantics) —
// this cache only removes the redundancy of calling nestedPrBlocks(b) with
// the SAME b, from scratch, many times over. That redundancy is real:
// subtreeApproveCount(kid) (below) is called once per chip in
// relatedChildren, again inside nestedChangedKids' own sort comparator
// (called multiple times per element by Array.prototype.sort), and again
// recursively at every one of nestedChangedKids' NESTED_DEPTH levels — on a
// real, densely-connected PR (many call sites resolving into a small set of
// shared helper methods) that re-walked the same shared subtree from
// scratch dozens of times, which multiplied into a multi-second main-thread
// stall reported as the tab going fully unresponsive (Chrome's "Page
// Unresponsive" dialog) while browsing a real PR's Underlying-code panel.
// Same historical shape as "A separate CPU stall, not a leak" in
// .claude/docs/frontend-memory.md, a different call chain than the one
// fixed there (this one runs off relatedChildren/nestedChangedKids, not the
// sidebar rollup) — don't call nestedPrBlocks(b) directly at a new
// top-level call site; use this instead.
let nestedPrBlocksCacheSrc = { allBlocks: null, relations: null, callResolve: null, testCovers: null }
let nestedPrBlocksTopCache = new Map()
function nestedPrBlocksCached(b) {
  if (
    nestedPrBlocksCacheSrc.allBlocks !== state.allBlocks ||
    nestedPrBlocksCacheSrc.relations !== state.relations ||
    nestedPrBlocksCacheSrc.callResolve !== state.callResolve ||
    nestedPrBlocksCacheSrc.testCovers !== state.testCovers
  ) {
    nestedPrBlocksCacheSrc = {
      allBlocks: state.allBlocks,
      relations: state.relations,
      callResolve: state.callResolve,
      testCovers: state.testCovers,
    }
    nestedPrBlocksTopCache = new Map()
  }
  const hit = nestedPrBlocksTopCache.get(b.id)
  if (hit) return hit
  const out = nestedPrBlocks(b)
  nestedPrBlocksTopCache.set(b.id, out)
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
  // A synthetic comment-index item (kind:'comment', see commentBlockItem) has
  // no changed rows to count — "resolved == approved" (Task decision): the
  // item now stands for a whole GROUP of comments on the same line/range
  // (b.comments, grouped by commentGroupKeyOf — a solo comment is a group of
  // one), so done/total sum over every comment in it instead of a fixed 0/1.
  // This is the ONE place that special-cases kind:'comment' for approval —
  // isFullyApproved itself (BlockList.mjs) stays generic, reading only
  // state.approvalSummaries[b.id], which subtreeApproveCount below fills from
  // this branch.
  if (b.kind === 'comment') {
    const comments = b.comments || [b.comment]
    return { done: comments.filter((c) => c && c.status === 'resolved').length, total: comments.length }
  }
  // A test_class row (see testClassRowItem/recomputeLeftList) sums its
  // METHODS' OWN rows only — deliberately NOT their nested Onderliggende-code
  // subtree (a resolved call target, a covers child, …). This is the pill
  // the sidebar row itself shows; the PR-wide "X/Y goedgekeurd" total does
  // NOT read this value — see subtreeApproveCount's own test_class branch
  // below, which sums the FULL per-method subtree instead, so nothing is
  // lost or double-counted there. See "Grouping test methods per class" in
  // .claude/docs/detail-layout.md for why these two are deliberately
  // different numbers.
  if (b.kind === 'test_class') {
    let done = 0
    let total = 0
    for (const m of b.methods) {
      const c = blockApproveCount(m)
      done += c.done
      total += c.total
    }
    return { done, total }
  }
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

// prWideApproveTotal sums blockApproveCount over the UNION of every block in the
// review tree — each block counted exactly ONCE, no matter how many top-level
// rows' subtrees it hangs under. That is the difference with summing
// subtreeApproveCount per row: nestedPrBlocks' cycle guard is per CALL, so a
// shared descendant (one helper called from twenty blocks) legitimately shows up
// in twenty subtrees and used to be added twenty times to the PR-wide header
// count. On a real PR that inflated both halves by the same factor (~5.8x on
// PR 13255: 10210/10742 instead of 1831/1856), which reads as "there is far more
// left to review than there is". The per-row PILLS deliberately keep counting
// their whole subtree and may overlap with a neighbour's — a row's pill answers
// "how much is left under THIS entry", the header answers "how much is left in
// the PR", and only the latter has to be a true union.
function prWideApproveTotal() {
  const seen = new Set()
  let done = 0
  let total = 0
  const add = (x) => {
    // Every entry that can reach here carries a unique id: a real block id, a
    // test method's block id, or a comment item's 'comment:<id>'.
    if (x.id) {
      if (seen.has(x.id)) return
      seen.add(x.id)
    }
    const c = blockApproveCount(x)
    done += c.done
    total += c.total
  }
  const walk = (b) => {
    // A comment-index item has no nested PR blocks — just its own 0/1 or 1/1.
    if (b.kind === 'comment') {
      add(b)
      return
    }
    // A test_class row is a grouping, not a block: its METHODS carry the rows
    // (mirrors subtreeApproveCount's own test_class branch).
    if (b.kind === 'test_class') {
      for (const m of b.methods) walk(m)
      return
    }
    add(b)
    for (const kid of nestedPrBlocksCached(b)) add(kid)
  }
  for (const b of state.blocks) {
    // A relation child ("Onderliggende code" index row) is already counted
    // inside its parent's subtree — but so is every other shared descendant
    // now, so this skip is only about not walking the same tree twice.
    if (state.underlyingIds[b.id]) continue
    walk(b)
  }
  return { done, total }
}

// subtreeApproveCount aggregates blockApproveCount over b and every PR block
// nested under it — the combined approval progress the sidebar shows.
function subtreeApproveCount(b) {
  // A comment-index item has no nested PR blocks (nestedPrBlocks assumes a
  // real block id/relations entry) — just its own 0/1 or 1/1.
  if (b.kind === 'comment') return blockApproveCount(b)
  // A test_class row: unlike blockApproveCount's own test_class branch above
  // (methods-only, for the sidebar pill), the PR-wide total needs the FULL
  // sum — each method's own subtreeApproveCount, including whatever hangs
  // under it (a resolved-but-hidden call target, a covers child, …). This is
  // mathematically identical to what the PR-wide total already summed
  // before grouping, when each method was its own top-level state.blocks
  // entry contributing its own subtreeApproveCount — grouping only changes
  // how these terms are iterated, never what they add up to. See
  // blockApproveCount's own comment for why the DISPLAY pill deliberately
  // uses a narrower number than this.
  if (b.kind === 'test_class') {
    let done = 0
    let total = 0
    for (const m of b.methods) {
      const c = subtreeApproveCount(m)
      done += c.done
      total += c.total
    }
    return { done, total }
  }
  let done = 0
  let total = 0
  for (const x of [b, ...nestedPrBlocksCached(b)]) {
    const c = blockApproveCount(x)
    done += c.done
    total += c.total
  }
  return { done, total }
}

// newLineToRowOf converts a 1-based NEW-side source line to its blockRows
// index — the same technique translationRowUnits (Block.mjs) builds locally
// for its own per-key rows, inlined here for a relation/testcover child's
// stored absolute line (childrenOf's `line`, testCoverRows' `r.line` — both
// documented as "the absolute source line within the [parent/test]'s own
// text", i.e. counted against the current head worktree = the new side).
function newLineToRowOf(rows, line) {
  if (!line) return null
  let seen = 0
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].right != null) {
      seen++
      if (seen === line) return i
    }
  }
  return null
}

// lineChildSummaries groups block b's directChildBlocks (relation children +
// resolved method calls + resolved test-covers targets) by the diff row
// they're anchored to, for the per-line "onderliggende code" badge rendered
// directly in the diff (Block.mjs's rowCellHTML/lineSummaryBadge, threaded
// via the lineSummaries opt) — an avatar+N comment-activity indicator plus a
// done/total approve fraction, right at the line the underlying code hangs
// off, so a reviewer doesn't have to open the Onderliggende-code panel to
// see there's still unapproved code (or an open comment) behind a call.
//
// Deliberately GRAN-INDEPENDENT, unlike relatedChildren/callScopeMethods:
// this must work identically for ANY visible diff card (the top-level
// selected/preview block, or any drilled column — see the Block(...) call
// sites in home.mjs), so it reuses directChildBlocks' own row-attribution
// sources directly instead of the cursor-scoped panel machinery.
//
// A child's anchor row is: for a relation child, its own `line` (childrenOf,
// counted against b's OWN text); for a resolved method call, the first
// call-site row findCallSites finds; for a resolved `covers` target (only
// when b is the covering test), its own annotation `line`. A child with no
// locatable site at all (an event-listener/relation without a `line`, or a
// block-level synthetic callKey like resource:/migration_model:/
// data_provider: — see isBlockLevelCallKey) is skipped here: it still shows
// in the Onderliggende-code panel, just not pinned to one diff line. A
// `covered_by` child (the test that covers b) is never included either — its
// annotation lives in the TEST's own file, not b's, so there is no site
// within b to anchor on (mirrors relatedChildren's own reasoning there).
//
// Deliberately ANCHORED ON ITS OWN ROW, never rolled up onto a wider
// STRUCTURAL change-group (Reindert, 2026-07-31: an earlier version rolled
// every child anchored anywhere within a multi-line changeGroups(rows) run
// up onto that group's FIRST row — "if it's on a group, show it on the
// group's first line" — which combined several stacked, unrelated calls
// (e.g. three separate requestCss(...) calls in one group) into a single
// badge on the first call's line, hiding that the other two calls even had
// their own underlying code. Every child now keeps its own exact row, so N
// calls stacked in one group show N independent badges, one per line.
function lineChildSummaries(b) {
  const map = new Map()
  if (!b || !b.code || b.code.error) return map
  const rows = blockRows(b)

  const buckets = new Map() // row -> Map(childId -> childBlock)
  const addTo = (row, kid) => {
    if (row == null || row < 0) return
    if (!buckets.has(row)) buckets.set(row, new Map())
    buckets.get(row).set(kid.id, kid)
  }

  const byId = allBlocksById()

  for (const { block: kid, line } of childrenOf(b)) {
    const row = newLineToRowOf(rows, line)
    if (row != null) addTo(row, kid)
  }
  for (const r of callRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    const kid = byId.get(callChildId(r))
    if (!kid) continue
    for (const site of findCallSites(rows, r.callKey)) addTo(site.row, kid)
  }
  for (const r of testCoverRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    const kid = byId.get(coveredChildId(r))
    if (!kid) continue
    if (r.line) {
      const row = newLineToRowOf(rows, r.line)
      if (row != null) addTo(row, kid)
    } else {
      // No natural single line (see testCoverGroupTier's own doc comment) —
      // anchor the badge on the test's own "// When" statement row(s)
      // instead of nowhere, mirroring the callRows loop above's multi-site
      // findCallSites attribution.
      for (const row of whenSectionRows(rows)) addTo(row, kid)
    }
  }

  // A comment placed directly ON this block's OWN row — not on an
  // underlying-code child — also counts toward this line's avatar+N badge
  // (Reindert, 2026-07-30: "a comment on the line itself should show the
  // avatar too", not only underlying-code activity). commentRowSet(b) is the
  // SAME row-presence Set the 💬 marker already uses (Block.mjs's
  // commentedFn) — reused here rather than re-scanning comments, so a row
  // without any comment never even gets a bucket entry for this reason.
  // Each such row is its own bucket, on its own line, exactly like a child's
  // anchor row above.
  const bKey = b.file + '|' + b.label
  for (const row of commentRowSet(b)) {
    if (!buckets.has(row)) buckets.set(row, new Map())
  }

  for (const [row, kidsById] of buckets) {
    let done = 0
    let total = 0
    const keys = new Set([bKey])
    for (const kid of kidsById.values()) {
      const c = subtreeApproveCount(kid)
      done += c.done
      total += c.total
      const ks = commentScopeKeys(kid)
      if (ks) for (const k of ks) keys.add(k)
    }
    // A child's own comments count regardless of which row WITHIN the child
    // they sit on (a child is a separate block — its rowStart lives in its
    // OWN aligned-row space, unrelated to b's). Only b's OWN comments (bKey)
    // are restricted to the row itself, via commentActivitySummary's
    // optional row filter — otherwise a comment on one line of b would bleed
    // onto every other line's badge too.
    const rowFilter = (c) => c.file + '|' + c.label !== bKey || c.rowStart === row
    const commentActivity = commentActivitySummary(keys, rowFilter)
    if (total > 0 || commentActivity) map.set(row, { approve: { done, total }, commentActivity })
  }
  return map
}

// unresolvedCalls returns the selected block's calls the Go resolver could not
// pin (status unresolved) plus any currently searching — feeding the automatic
// LLM search plus, for the `searching` ones only, the panel's "zoeken…" pill
// (see RelatedPanel.mjs). Scoped like relatedChildren (see callScopeMethods):
// in diff mode only the calls under the selected unit (group/line/call), so the
// search is coupled to what you selected; in list mode the block's whole set.
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
        repo: state.repo || undefined,
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

// invalidateCodeCache forgets the "already fetched" marks for the files given,
// so ensureCode/ensureLangSiblings really re-read them the next time a card
// renders. Needed because GET /api/blocks carries NO source at all (model.go
// has no code field) while GET /api/code serves it LIVE out of the head
// worktree (code.go's extractBlockSource → os.ReadFile) — a worktree an
// ingest refresh has already moved to the new commit. So after a refresh the
// server would happily hand out the new source, but this cache pinned every
// touched block to the source it had BEFORE the landing, permanently: the
// reviewer saw pre-edit code (or, once the fresh block objects had replaced
// the old ones, no diff at all) until a full page reload dropped this Set with
// the rest of the module. Reviewer report: "ik zie de aanpassing niet
// verschijnen, ook na 10 seconden niet, als ik dan refresh wel."
//
// Keys are `file|label|side` (ensureCode) and the block id (ensureLangSiblings,
// `<pr>:<file>:<symbol>` — so it embeds its own file path), hence the two
// different matches. No files given → clear both wholesale; the
// only cost of over-invalidating is one extra fetch per visible card.
function invalidateCodeCache(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : []
  if (!list.length) {
    codeRequested.clear()
    langSiblingRequested.clear()
    return
  }
  for (const f of list) {
    const prefix = f + '|'
    for (const key of [...codeRequested]) if (key.startsWith(prefix)) codeRequested.delete(key)
    for (const id of [...langSiblingRequested]) if (String(id).includes(f)) langSiblingRequested.delete(id)
  }
}

// ensureCode lazily fetches the old/new source of a block and stashes it on the
// block as `b.code` (reactive → the Block card re-renders). `b.code` is null
// while loading, then { file, old, new } or { error }.
async function ensureCode(b) {
  // A synthetic drill frame (a call into a file this PR doesn't change) already
  // carries its source inline (built in drillIntoChild from the call-row's
  // childCode); there's no stored PR block to fetch, so never hit /api/code for it
  // — that would clobber the inline code with null and hang on "loading".
  if (b.synthetic) return
  // A synthetic comment-index item (kind:'comment', see commentBlockItem) or
  // a synthetic test_class row (see testClassRowItem) has no source to fetch
  // itself — neither has a real .file/.label/.side (a test_class row's own
  // code lives entirely in its .methods, each fetched individually when it
  // becomes the active method — see curBlock()), so /api/code would 404
  // uselessly.
  if (b.kind === 'comment' || b.kind === 'test_class') return
  const key = b.file + '|' + b.label + '|' + b.side
  if (codeRequested.has(key)) return
  codeRequested.add(key)
  b.code = null
  try {
    const params = new URLSearchParams({ pr: state.pr, file: b.file, name: b.name })
    if (state.repo) params.set('repo', state.repo)
    if (b.class) params.set('class', b.class)
    // A renamed file's OLD source lives at its pre-rename path in the base
    // worktree — tell the server so the old diff side is read from there.
    if (b.oldFile && b.oldFile !== b.file) params.set('oldFile', b.oldFile)
    // Same for a renamed/moved METHOD: its OLD source sits under the pre-move
    // symbol in the base worktree (blockmove.go stamps oldName/oldClass). Sent
    // as a pair — the server only honours oldClass together with oldName.
    if (b.oldName) {
      params.set('oldName', b.oldName)
      params.set('oldClass', b.oldClass || '')
    }
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
    // curBlock() (not a raw state.blocks[state.selected] read) so this also
    // fires for the ACTIVE method of a selected test_class row.
    if (curBlock() === b) {
      const groups = unitsOf(b)
      // We stepped up into this block before its code loaded — now that its
      // change groups are known, land on the last one.
      if (pendingLast) {
        state.change = Math.max(0, groups.length - 1)
        pendingLast = false
      } else if (pendingFirstUnapproved) {
        // We stepped INTO this block (enterDiff) before its code loaded — now
        // that its units and their approval state are known, land on the first
        // one that still needs approval (falling back to the first unit).
        state.change = firstUnapprovedChange(b)
        pendingFirstUnapproved = false
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
    } else {
      // A drilled column's code just arrived (a real PR block whose source
      // wasn't fetched yet — see drillIntoChild) — any level, not only the
      // focused/deepest one: an ANCESTOR drilled while its own code was still
      // in flight (applyDrillRefRestore walks the whole path synchronously)
      // needs its restored cursor applied here too, once its rows are known —
      // see applyDrillCursorRestoreAt/state.drillCursorRef's own comment.
      const drillIdx = state.drill.indexOf(b)
      if (drillIdx >= 0) {
        if (drillIdx === state.focusLevel - 1) {
          // A restored ?dgran=/?dchg= cursor (see applyDrillCursorRestore) can
          // only be applied once this column's rows are actually known — do
          // that first so the scroll below centres the RESTORED unit, not the
          // default first one.
          applyDrillCursorRestore(b)
        }
        applyDrillCursorRestoreAt(drillIdx + 1, b)
        if (drillIdx === state.focusLevel - 1) {
          // A focused drilled column's code just arrived — jump straight to
          // its first (or just-restored) change group now that the
          // rows/anchor can be rendered, mirroring the top-level
          // scroll-on-load above. Without this the reviewer lands on the top
          // of the (often large) function body with the actual diff hunk
          // scrolled out of view, looking as if the red/green formatting is
          // simply missing. An ancestor column is collapsed to a rail and
          // never scrolled to, so this stays scoped to the focused one.
          scrollChangeIntoView(false)
        }
      }
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

// langSiblingRequested guards against re-fetching a TRANSLATION block's sibling
// locales (outside reactive state — reading it must never create a dependency).
const langSiblingRequested = new Set()

// ensureLangSiblings lazily fetches, for a changed lang (TRANSLATION) block,
// the OTHER locale files of the same lang file, so Block.mjs's translationSlot
// can show each locale's current value as an extra column on every per-key
// row (see translationDiff.mjs's translationBlockView "siblings" opt) — this
// used to feed a separate, read-only companion card next to the block; that
// card is gone, the sibling values now render as columns inside the SAME
// card/row instead (see .claude/docs/blocks-and-ingest.md, "Translation
// blocks"). Best-effort: GET /api/langsiblings is read-only (reads the head
// worktree, like /api/code), a failure just leaves no sibling columns.
// Reassigns state.langSiblings wholesale, and ALSO bumps state.codeVersion:
// Block.mjs's own nested TRANSLATION slot reads state.langSiblings directly
// (not co-subscribed with anything else there), but the wholesale
// reassignment alone has already been observed to intermittently not
// re-trigger a dependent closure elsewhere in this file for the exact same
// reason the "arrow.js reuses a keyed node... drops the null→loaded update"
// pitfall describes (conventions.md) — bumping state.codeVersion is the
// same, already-established, reliable fallback trigger every other
// b.code-adjacent update in this file uses.
async function ensureLangSiblings(b) {
  if (!b || b.category !== 'TRANSLATION' || langSiblingRequested.has(b.id)) return
  langSiblingRequested.add(b.id)
  try {
    const res = await fetch(`/api/langsiblings?pr=${state.pr}&file=${encodeURIComponent(b.file)}${repoQuery}`)
    if (!res.ok) return
    const body = await res.json()
    const sibs = Array.isArray(body.siblings) ? body.siblings : []
    state.langSiblings = { ...state.langSiblings, [b.id]: sibs }
    state.codeVersion++
  } catch (_) {
    /* offline — no sibling columns */
  }
}

async function ingest() {
  state.error = ''
  state.ingesting = true
  try {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr, repo: state.repo || undefined }),
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
  // Same "cover the cases nothing scrolls" role, for the comment/Claude-chat/
  // code-preview scroll-hint hosts (src/scrollFade.mjs) — a code load or a
  // resize can just as well change one of those, not only a diff.
  refreshScrollHints()
}

window.addEventListener('resize', refreshHints)

// scrollSelectedIntoView keeps the highlighted row visible. Deferred so the DOM
// has the new highlight class before we measure.
function scrollSelectedIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(
      state.pushTodoFocused
        ? '[data-testid="push-todo"]'
        : state.batchRowFocused
          ? '[data-testid="batch-action-row"]'
          : state.ignoreToggleFocused
            ? '[data-testid="toggle-ignored"]'
            : state.toggleFocused
              ? '[data-testid="toggle-approved"]'
              : `[data-idx="${state.selected}"]`
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
  // A newly selected row can bring a fresh comment-detail-thread (a PR-wide
  // comment index item) into the DOM with no other trigger to re-measure its
  // scroll hints — see refreshHints' own comment.
  refreshScrollHints()
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
function scrollChangeIntoView(animate = true, tries = 10, settle = true) {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-change-active]')
    if (!el) {
      if (tries > 0) scrollChangeIntoView(animate, tries - 1, settle)
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
  // A non-animated recentre runs right after a focus-level change (closing a
  // drilled column via ←, expanding a collapsed rail) — exactly the moments
  // that can also flip <main>'s own bottom offset (the footer's reserved
  // height, see detail-layout.md's footerVisible/footerExplain reservation)
  // through its existing 200ms CSS transition (`duration-200`). The rAF above
  // can measure the scrollsync container's clientHeight mid-transition (e.g.
  // right as the footer/its AI explanation collapses or grows), landing the
  // centred row a few px outside the pane once the transition actually
  // settles — the same width-transition race `resettleCallArrows` already
  // guards against for the `a` toggle (see conventions.md). One extra,
  // harmless re-run once the transition has settled fixes it; `settle` guards
  // against recursing forever (this follow-up call passes settle=false).
  if (!animate && settle) {
    setTimeout(() => scrollChangeIntoView(false, tries, false), 220)
  }
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
  // A synthetic comment-index item (kind:'comment') has no diff — → on it is
  // instead handled in onKeydown (opens the prComment action menu) and never
  // reaches this function via that path; guarded here too as a defensive
  // no-op for any other caller (f, applyDefaultUnapprovedSelection's
  // scroll-only landing, …).
  if (!b || b.kind === 'comment') return
  // A test_class row (see testClassRowItem/recomputeLeftList) has no diff of
  // its OWN — → first opens the methodes-kolom (stop 2b of the left→right
  // nav chain, see keyboard-navigation.md) instead of stepping straight into
  // diff mode; only a SECOND → (the column already owning the keyboard —
  // state.testColumnFocused) actually enters the diff, and then of the
  // ACTIVE method (state.classMethodSel), not of the row itself.
  if (b.kind === 'test_class') {
    if (!state.testColumnFocused) {
      state.testColumnFocused = true
      if (state.classMethodSel >= b.methods.length) state.classMethodSel = 0
      return
    }
    if (!b.methods.length) return
  }
  state.mode = 'diff'
  // Stepping in never lands ON the description strip — it is only reachable
  // with a deliberate ↑ from the block's first change (reviewer: "het moet niet
  // gelijk geselecteerd zijn als ik een blok open").
  clearBlockDescFocus()
  // Entering a diff always takes the keyboard out of stop 1 and, by default,
  // gives the pr-index' width back to the diff — the nav-chain behaviour the
  // KEYBOARD has always had. A mouse click can hand either column back
  // afterwards, but only if it genuinely fits: ensureTopLevelDiffFocus (the
  // one mouse entry point) calls scheduleDiffColumnFit right after this, which
  // re-evaluates both flags. See state.descriptionPinned/keepIndexInDiff.
  state.keepIndexInDiff = false
  if (state.showDescription) {
    // Only reachable from the mouse: the keyboard's own → at stop 1 merely
    // closes the description (onKeydown's showDescription branch) and never
    // reaches enterDiff. Provisionally KEEP the column on screen (the fit pass
    // may drop it again) while handing the keyboard to the diff.
    state.showDescription = false
    state.descriptionPinned = true
    state.blockIndexEntered = true
  }
  // The four trailing-row focus flags (toggle-approved/toggle-ignored/
  // batch-action/push-todo) only ever mean something in LIST mode, at the
  // bottom of the sidebar — being in diff mode with one of them still true is
  // an invalid combination. The ordinary keyboard path can never reach here
  // with one set (onKeydown's own trailing-row guard swallows ArrowRight/f/d/
  // s/Space/Enter while any of them is true — see that guard's own comment),
  // but a MOUSE click on the list-mode look-ahead preview reaches enterDiff
  // via ensureTopLevelDiffFocus, bypassing that keyboard guard entirely. Found
  // via manual testing on a real, already fully-approved single-block PR:
  // applyDefaultUnapprovedSelection lands state.toggleFocused true without
  // moving state.selected off the (now sidebar-hidden) approved block (see
  // the "everything approved" test in fresh-open-default-selection.spec.mjs)
  // — so that block's diff still renders in the list-mode preview panel on
  // the right. A click straight into one of its rows then entered diff mode
  // without ever clearing the flag — every later Enter/f/d/s/Space in that
  // diff silently kept hitting the toggle-row branches instead (e.g. Enter
  // toggled "Show N approved blocks" instead of opening the block palette).
  // Clearing them here, at the one function every "enter diff" path funnels
  // through (keyboard AND mouse), covers both. Regression test: "a mouse
  // click into the still-visible preview diff clears the stale toggle-row
  // focus" in fresh-open-default-selection.spec.mjs.
  state.toggleFocused = false
  state.ignoreToggleFocused = false
  state.batchRowFocused = false
  state.pushTodoFocused = false
  state.staleRowFocused = false
  // Stepping into a diff leaves the sidebar's own multi-row selection behind.
  clearListAnchor()
  // Stepping in from the list always starts at the coarsest granularity (a whole
  // change run); the reviewer refines from there with f.
  state.gran = 'group'
  // Land on the first unit that still needs approval instead of always on the
  // block's first change (reviewer request: "als ik naar links ga en direct
  // naar rechts, wil ik op de regel belanden die nog niet approved is, anders
  // wel gewoon de eerste"). Deliberately scoped to this list→diff step only —
  // drilling into an Onderliggende-code column keeps starting at its own first
  // unit (drillIntoChild), and every other landing (applyNextUnapproved,
  // openTask, the URL restore) sets its own change explicitly and never comes
  // through here. curBlock() rather than `b`: for a test_class row the diff we
  // step into is the ACTIVE method's, not the row's own.
  const target = curBlock()
  pendingLast = false
  if (target && target.code) {
    state.change = firstUnapprovedChange(target)
    pendingFirstUnapproved = false
  } else {
    // Code still loading — ensureCode resolves the landing once the rows (and
    // thus the units and their approval state) are known, exactly like
    // pendingLast does for a step UP into a neighbouring block.
    state.change = 0
    pendingFirstUnapproved = true
  }
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

// advanceToNextBlockFromClaudeChat is what ↓ at the bottom of the embedded
// Claude conversation does instead of falling into the Onderliggende-code
// panel — "the bottom" being the rest position (cs.claudePos === 0) with no
// code-preview cards left below it either (cs.previewPos walks those first,
// see handleRelatedKey's 'advance' sentinel,
// RelatedPanel.mjs) — explicit request: reviewing a unit's chat/comments
// shouldn't dead-end into another panel before moving on. handleRelatedKey has
// already released the panel focus (exitRelated), so this only needs to move
// the selection and step into the next block's diff; enterDiff() itself
// resets drill/gran/change and re-aligns <main>'s scroll. A no-op at the last
// visible block (stepVisibleSelected clamps by returning the same index).
function advanceToNextBlockFromClaudeChat() {
  const next = stepVisibleSelected(1)
  if (next === state.selected) return
  selectRow(next)
  enterDiff()
  scrollSelectedIntoView()
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
  // A comment on a test method no longer has its own top-level row (see
  // testClassRowItem/recomputeLeftList) — if it's not found there directly,
  // look inside every test_class row's own methods too.
  let idx = state.blocks.findIndex((b) => b.kind !== 'test_class' && b.file === c.file && b.label === c.label)
  let b
  if (idx >= 0) {
    state.classMethodSel = 0
    state.testColumnFocused = false
    b = state.blocks[idx]
  } else {
    idx = state.blocks.findIndex(
      (row) => row.kind === 'test_class' && row.methods.some((m) => m.file === c.file && m.label === c.label),
    )
    if (idx < 0) return
    const row = state.blocks[idx]
    const mIdx = row.methods.findIndex((m) => m.file === c.file && m.label === c.label)
    state.classMethodSel = mIdx
    state.testColumnFocused = true
    b = row.methods[mIdx]
  }
  state.selected = idx
  state.mode = 'diff'
  state.drill = []
  state.drillCursor = []
  state.focusLevel = 0
  state.rangeAnchor = null
  resetMainScroll()
  await ensureCode(b)
  const rows = blockRows(b)
  const gran = c.gran || 'group'
  state.gran = gran
  const units = navUnitsOf(b, rows, gran)
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

// jumpToClaudeConversation lands the keyboard on a DIFFERENT running Claude
// conversation's own code/comment and opens it — the Enter (or click) action
// of the "other running Claude tasks" nested nav stop (see
// otherClaudeChats/selectHighlightedClaudeTask, RelatedPanel.mjs, and
// "Where a turn on OTHER code is visible" in .claude/docs/claude-chat-panel.md
// for the underlying registry it reads). Registered once via
// setClaudeTaskJump right below, since RelatedPanel.mjs owns neither `state`
// (block selection) nor jumpToCommentRow (comment-index rows can still be a
// poll tick away) — both live here.
//
// A comment carrying its own `kind` is a PR-wide/comment-index row (its own
// synthetic "Start" row, see commentBlockItem below); anything else is an
// ordinary inline comment anchored to a real block, landed via openTask's own
// file/label lookup (test_class rows included). Best-effort throughout, same
// as openTask itself: a stale/racy jump (the comment/row gone by the time an
// await resolves) simply does nothing further.
async function jumpToClaudeConversation(c) {
  if (!c) return
  if (c.kind) {
    jumpToCommentRow(c.id)
    // The row may still be a poll tick away (see jumpToCommentRow's own doc
    // comment) — give it the couple of microtask turns openTask already
    // relies on elsewhere before claiming the keyboard.
    await Promise.resolve()
    await Promise.resolve()
  } else {
    await openTask({ comment: c, runId: c.id })
  }
  await enterClaudeChat(state.pr)
}
setClaudeTaskJump(jumpToClaudeConversation)

// jumpToPendingEditBlock lands the keyboard on the block a pending-edits
// link points at (see setEditsJumpCallback, RelatedPanel.mjs's
// pendingEditsItem) — Enter/click on one of the links in the pending-edits
// card shown below the chat (see "A pending-edits card, walked the same way
// as the chat's own code blocks" in .claude/docs/claude-chat-panel.md).
// blockId is only ever a real match here — RelatedPanel.mjs never calls this
// for a plain, non-clickable entry (a touched file with no matching block in
// the currently loaded tree).
function jumpToPendingEditBlock(blockId) {
  const idx = state.blocks.findIndex((b) => b.id === blockId)
  if (idx < 0) return
  state.selected = idx
  state.mode = 'diff'
  state.drill = []
  state.drillCursor = []
  state.focusLevel = 0
  state.rangeAnchor = null
  resetMainScroll()
}
setEditsJumpCallback(jumpToPendingEditBlock)

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
// `ms.native`/`ms.x`/`ms.y` are only meaningful while `ms.native` is true — the
// right-click context-menu variant (see openMenu/positionNativeMenu below and
// "The right-click context menu" in command-palette.md): CommandMenu renders
// without a search field and positionMenu places the box at (x, y) instead of
// under a diff-row/region anchor.
let ms = reactive({ query: '', sel: 0, sub: null, mode: 'block', commands: [], native: false, x: 0, y: 0 })

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
  return [{ id: 'close-menu', label: t('Sluit menu'), hint: 'sluit', run: onClose || (() => {}) }, ...list]
}

// defaultSel picks the initial selection for a freshly opened menu/submenu:
// the 2nd item (index 1), so the pinned "Sluit menu" is never itself the
// default Enter action — but never past the end, so a list with 0 or 1 real
// item still gets a valid index instead of pointing at nothing. `list` is
// always the RAW list (withClose's pinned row still at index 0) — the same
// one passed to `ms.commands`.
//
// `native` (a right-click context menu) has no pinned row at all in the
// FILTERED list resolveCommands/CommandMenu actually walk (see
// resolveCommands' own native filter just below, which drops 'close-menu'
// whether or not `list` — always the RAW, unfiltered list — happens to carry
// one), so its first real action already sits at index 0.
function defaultSel(list, native) {
  if (native) return 0
  return Math.min(1, Math.max(0, list.length - 1))
}

// deleteCommentAndSelectRow deletes the focused comment and then moves the
// keyboard cursor onto the diff row/unit it was anchored to — "after removing
// a comment on a line, I want that line selected" (reported). The inline
// comment panel only ever shows a comment anchored on the column that
// currently owns the keyboard (focusedBlock(), see hasVisibleComments/
// InlineComments in detail-layout.md), so the target unit is always within
// THAT block — no cross-block jump is ever needed here. Snapshots the
// comment's own anchor (gran/rowStart) and the focused block BEFORE the
// await, since deleteFocusedComment's reload can (via the existing
// cs.list.length===0 clamp) itself already touch cs.focus/cs.sel — this
// function's own cursor move must win regardless of that clamp's outcome.
// Falls back to row 0 for an unpinned/never-anchored comment (rowStart < 0,
// see the re-anchor-pass doc in tembed-workflows.md) — the same fallback
// openTask already uses for exactly that case, not a new judgment call.
//
// EXCEPT while the sidebar cursor sits on the comment/chat "Start" row this
// thread belongs to (isCommentIndexRowActive — a "Comments op regels"
// anchor's own entered thread; see afterResolveAction's matching gate,
// 2026-08-27): landing back on a diff row makes no sense once that whole row
// is about to disappear from the blokken-index, so this jumps straight to
// afterCommentRowRemoved (the next still-open comment/chat row) instead. The
// beforeIdx snapshot (state.selected, taken before the delete) is needed
// because deleteFocusedComment's own reload can already reindex/clamp
// state.selected by the time this resumes — findNextUnresolvedCommentFrom
// must resume scanning from the deleted row's OLD position, not from
// whatever state.selected happens to be afterward.
async function deleteCommentAndSelectRow() {
  const c = focusedComment()
  const b = focusedBlock()
  const wasCommentIndexRow = isCommentIndexRowActive()
  const beforeIdx = state.selected
  await deleteFocusedComment()
  if (wasCommentIndexRow) {
    await afterCommentRowRemoved(beforeIdx)
    return
  }
  if (!c || !b) return
  const rows = blockRows(b)
  const gran = c.gran || 'group'
  const units = navUnitsOf(b, rows, gran)
  const anchorRow = c.rowStart >= 0 ? c.rowStart : 0
  const change = units.length ? unitAtRow(units, anchorRow) : 0
  clearRangeAnchor()
  if (state.focusLevel > 0) {
    state.drillCursor = state.drillCursor.map((cur, i) => (i === state.focusLevel - 1 ? { gran, change } : cur))
  } else {
    state.gran = gran
    state.change = change
  }
  leaveRelated()
  scrollChangeIntoView()
}

// commentCommandsFor builds COMMENT_COMMANDS freshly every time (called from
// openMenu('comment'), plain non-reactive code — see rootCommandsFor): Enter on
// a focused comment row (not mid-reply) offers resolving or deleting it. Kept
// separate from COMMANDS (block actions) since a comment isn't tied to the
// selected block/diff. "Resolve comment" also resolves the conversation on
// GitHub (for a review-diff thread) — see resolveFocusedComment
// (RelatedPanel.mjs) and the reply-loop's resolveGithubThread Activity
// (workflows.go). On an already resolved thread that first item is
// "Unresolve comment" instead (isResolvedComment → unresolveFocusedComment,
// which mirrors both halves: the status AND the GitHub conversation).
// "Sluit menu" is pinned first (withClose); the menu opens on
// the 2nd item (defaultSel), so "Resolve comment" stays the default Enter
// action — EXCEPT for an AI finding (isAiComment), which has no resolve slot
// at all and therefore opens on "Verwijder comment": deleting it immediately,
// with no confirm step, is exactly what the reviewer asked for. A bare
// Claude-chat anchor (isChatAnchorPlaceholder — no reviewer text was ever
// typed, see claude-chat-panel.md) drops the same slot for the same reason:
// there is no real reviewer comment here to resolve, only a conversation to
// delete (reviewer request: "wil ik niet kunnen resolven, alleen kunnen
// verwijderen").
// This is already true regardless of who wrote the comment — unlike
// prCommentCommandsFor below, this menu has no "Beantwoorden" item to reorder
// (a block-scoped comment's reply field is always visible and typed into
// directly; this menu only ever opens once that field is empty, see
// commentReplyEmpty/isCommentOrThreadFocused in RelatedPanel.mjs), so isOwnComment
// (see prCommentCommandsFor) doesn't apply here.
//
// "Open op GitHub" is appended at the bottom, ONLY when the focused comment
// actually has a GitHub anchor (focusedCommentGithubId() — a local/private
// note, or a comment whose GitHub post hasn't landed yet/failed, has none) —
// this is a data-conditional list (not a static const like the block above),
// so it must be built here, at open time, rather than once at module load;
// this mirrors the existing resolveLabel/snapshotCommands pattern of reading
// live state exactly once, non-reactively, so nothing that reads global state
// ever reaches CommandMenu's never-disposed reactive tree (see the "disposal
// gap" note in conventions.md). The comment-scoped panel only ever shows
// block-scoped comments (kind === '', see recomputeView's !c.kind filter in
// RelatedPanel.mjs), which are always a GitHub review/diff comment — so the
// anchor form is always "#discussion_r<id>", never "#issuecomment-<id>".
//
// "Comment hiervan maken" is appended right after Resolve/Delete — but only
// for an AI-authored finding (focusedComment().source === 'ai', see
// aiWarningBadge in RelatedPanel.mjs) — the code_warning workflow's own
// finding text is often worth turning into a real, reviewer-owned comment
// (editable before it's placed) rather than left as-is. Deliberately NOT the
// default item (Resolve comment stays that, per keyboard-navigation.md) —
// pushed after Resolve/Delete instead of unshifted to the front.
// publishThreadCommand — the "Zet op GitHub" item both comment menus get for a
// thread that has never touched GitHub (needsPublishChoice). It is how an
// EXISTING local conversation moves over without first typing a new reply:
// `Enter` on an empty reply field already opens the comment menu, so this needs
// no new nav stop or key of its own, and it deliberately never runs on that
// first keypress — Resolve stays the default item.
//
// With earlier local replies it opens a submenu (bring them along or not),
// exactly like the replyPublish menu's own GitHub items; without any it is a
// plain item, since there would be only one possible answer. Both labels are
// plain strings built here, at open time.
//
// `doPublish(withHistory)` fully replaces the plain `publishThreadOnly(c,
// withHistory)` call — the caller decides where the keyboard lands next (see
// `publishThreadAndSelectRow`/`publishPrCommentAndExit` below), since a
// block-scoped thread and a PR-wide comment-index item have different rest
// positions to return to (mirroring the same split between
// `deleteCommentAndSelectRow` and `deletePrCommentItem`). Defaults to the bare
// call for any future caller that doesn't care.
function publishThreadCommand(c, doPublish) {
  const n = localReplyCount(c)
  const isAI = (c.source || 'ui') === 'ai'
  const rootNoun = isAI ? t('de AI-melding') : t('mijn comment')
  const publish = doPublish || ((withHistory) => publishThreadOnly(c, withHistory))
  if (n === 0) {
    return {
      id: 'comment-publish',
      label: t('Zet op GitHub'),
      hint: 'github',
      run: () => publish(false),
    }
  }
  return {
    id: 'comment-publish',
    label: t('Zet op GitHub'),
    hint: 'github',
    children: withClose([
      {
        id: 'comment-publish-root',
        label: t('Alleen {noun}', { noun: rootNoun }),
        hint: 'alleen dit',
        run: () => publish(false),
      },
      {
        id: 'comment-publish-history',
        label: t(n === 1 ? 'Met de eerdere {n} bericht' : 'Met de eerdere {n} berichten', { n }),
        hint: 'hele gesprek',
        run: () => publish(true),
      },
    ]),
  }
}

// publishThreadAndSelectRow — after "Zet op GitHub" publishes a block-scoped
// local thread, hand the keyboard back to the diff row it was anchored to,
// exactly like `deleteCommentAndSelectRow` does for a delete. Reviewer
// request: "na ai warning, zet op github, laat mij verder navigeren door
// code (volgens mij doe je dat ook al voor andere keren dat we op github het
// gooien)" — confirmed to apply to every local thread's own "Zet op GitHub",
// not just an AI finding, since `publishThreadOnly` is the one shared
// function both use. This REVERSES an earlier, explicitly documented decision
// ("publishThreadOnly never closes the thread", see
// tests/reply-publish-local-thread.spec.mjs) — snapshots the focused block
// BEFORE the await, same reasoning as `deleteCommentAndSelectRow`: the reload
// inside `publishThreadOnly` can itself touch `cs.focus`/`cs.sel`.
async function publishThreadAndSelectRow(c, withHistory) {
  const b = focusedBlock()
  await publishThreadOnly(c, withHistory)
  if (!b) return
  const rows = blockRows(b)
  const gran = c.gran || 'group'
  const units = navUnitsOf(b, rows, gran)
  const anchorRow = c.rowStart >= 0 ? c.rowStart : 0
  const change = units.length ? unitAtRow(units, anchorRow) : 0
  clearRangeAnchor()
  if (state.focusLevel > 0) {
    state.drillCursor = state.drillCursor.map((cur, i) => (i === state.focusLevel - 1 ? { gran, change } : cur))
  } else {
    state.gran = gran
    state.change = change
  }
  leaveRelated()
  scrollChangeIntoView()
}

// publishPrCommentAndExit — the PR-wide comment-index counterpart: there is
// no diff row to land on for such an item (same reasoning as
// `deletePrCommentItem`'s own doc comment), so this just releases the thread
// cursor back to the item's rest position, mirroring `postPrCommentReply`'s
// own optimistic exit.
async function publishPrCommentAndExit(c, withHistory) {
  await publishThreadOnly(c, withHistory)
  exitPrCommentThread()
}

// isResolvedComment — whether a comment thread is currently resolved, i.e.
// whether its menu offers "Unresolve comment" instead of "Resolve comment".
// Both menus below show exactly ONE of the two, in the same slot, so the
// default-Enter item keeps meaning "flip this thread's state".
function isResolvedComment(c) {
  return !!c && c.status === 'resolved'
}

// isAiComment — whether this comment is a code_warning finding rather than a
// human conversation: an anchored one carries Source "ai" (code_warning.go),
// an unanchored one additionally carries Kind "ai_warning". Same pair as
// isBatchEligible (commentBatch.mjs) and comment_batch.go's own check.
//
// Reviewer request ("ai comments wil ik niet resolven, maar wil ik
// verwijderen"): BOTH menus below drop their resolve/unresolve slot entirely
// for such a finding — resolving is a conversation concept that doesn't apply
// to it, deleting is what the reviewer actually does with one. Unresolve goes
// too, not just resolve: the whole notion doesn't belong on an AI finding.
// A block-anchored finding can be the primary comment of a mixed index group
// (commentGroupKeyOf only excludes kind/orphan comments), in which case that
// group row has no resolve item until the finding itself is deleted —
// accepted.
function isAiComment(c) {
  return !!c && ((c.source || '') === 'ai' || c.kind === 'ai_warning')
}

function commentCommandsFor() {
  const focused = focusedComment()
  const items = []
  // A still-bare Claude-chat anchor (nothing real behind it yet) has no
  // resolve/unresolve concept — see isAiComment's own doc comment for the
  // sibling AI-finding case. Once the reviewer's own first reply has taken
  // it over (firstReviewerReplyOnPlaceholder), it IS an ordinary open
  // comment and gets its ordinary Resolve item back.
  if (!isAiComment(focused) && !(isChatAnchorPlaceholder(focused) && !firstReviewerReplyOnPlaceholder(focused))) {
    items.push(
      isResolvedComment(focused)
        ? {
            id: 'unresolve-comment',
            label: t('Unresolve comment'),
            hint: 'heropen',
            run: () => unresolveFocusedComment(),
          }
        : {
            id: 'resolve-comment',
            label: t('Resolve comment'),
            hint: 'resolve',
            run: async () => {
              const wasCommentIndexRow = isCommentIndexRowActive()
              const beforeIdx = state.selected
              await resolveFocusedComment()
              await afterResolveAction(wasCommentIndexRow, beforeIdx)
            },
          },
    )
  }
  items.push({
    id: 'delete-comment',
    label: t('Verwijder comment'),
    hint: 'delete',
    run: () => deleteCommentAndSelectRow(),
  })
  const c = focused
  // "Bewerk bericht" edits whichever message the keyboard is currently ON —
  // the root/opening message at rest, or the specific reply stepped into via
  // ↑ (see focusedThreadMessage's own doc comment) — only ever shown for the
  // reviewer's OWN message (isOwnMessage), never a foreign or AI one.
  const msg = focusedThreadMessage()
  if (isOwnMessage(msg)) {
    items.push({
      id: 'comment-edit',
      label: t('Bewerk bericht'),
      hint: 'edit',
      run: () => startEditMessage(c, msg),
    })
  }
  if (c && c.source === 'ai') {
    items.push({
      id: 'comment-from-warning',
      label: t('Comment hiervan maken'),
      hint: 'convert',
      run: () => convertWarningToComment(c),
    })
  }
  if (needsPublishChoice(c))
    items.push(publishThreadCommand(c, (withHistory) => publishThreadAndSelectRow(c, withHistory)))
  const githubId = focusedCommentGithubId()
  if (githubId) {
    items.push({
      id: 'comment-github',
      label: t('Open op GitHub'),
      hint: 'github',
      run: () => window.open((state.prUrl || GITHUB_PR) + '#discussion_r' + githubId, '_blank'),
    })
  }
  return withClose(items)
}

// claudeChatClearConfirmCommandsFor — the one-more-step confirm submenu for
// "Wis Claude-gesprek", used ONLY when there is real work to lose: pending
// (uncommitted/unpushed) agentic-edit work in the conversation's own shadow
// worktree, which clearing would discard (chat_workflow.go's chatActionClear).
// Reviewer request ("na wis claude gesprek, hoef ik geen bevestiging te zien",
// then: "dan wel als bevestigingscherm laten in dat geval") — an ordinary
// conversation clears on the first Enter, see claudeChatCommandsFor.
//
// `warning` therefore doubles as the gate AND the label: this submenu is never
// built without one, so there is no plain "Ja, wis dit gesprek" variant left.
// It comes from claudeChatShadowWarning, a plain snapshot read of the cache
// refreshed by enterClaudeChat right after entering the chat (RelatedPanel.mjs)
// — the menu is built by non-reactive code that cannot await a fetch. A failed
// or still-pending check therefore reads as "nothing to lose" and clears
// straight away; that is the accepted trade-off for not blocking the menu on a
// network round trip, not an oversight.
function claudeChatClearConfirmCommandsFor(warning) {
  return withClose([
    {
      id: 'clear-claude-chat-confirm',
      label: t('Ja, toch wissen — {warning}', { warning }),
      hint: 'bevestig',
      run: () => runClearClaudeChat(),
    },
  ])
}

// runClearClaudeChat wraps clearClaudeChat with the same "in de blokken
// index bezig" navigation gate as afterResolveAction/deleteCommentAndSelectRow
// (reviewer request, 2026-08-27: "alleen als de rij verdwijnt"). Only when
// BOTH hold — the cursor sits on the comment/chat row this chat hangs off
// (isCommentIndexRowActive), snapshotted before clearClaudeChat runs since it
// can call exitRelated() itself, AND clearClaudeChat itself reports the
// backing comment/index row was actually deleted (the bare-placeholder
// branch — a chat hanging off a REAL reviewer comment leaves that row in
// place, so nothing should navigate away from it) — jump to
// afterCommentRowRemoved. One shared wrapper for both entry points below
// (the direct "Wis Claude-gesprek" Enter and this confirm submenu's own
// item), same reasoning as every other run/click pairing in this file.
async function runClearClaudeChat() {
  const wasCommentIndexRow = isCommentIndexRowActive()
  const beforeIdx = state.selected
  const removed = await clearClaudeChat()
  if (removed && wasCommentIndexRow) await afterCommentRowRemoved(beforeIdx)
}

// claudeChatCommandsFor — the root list for Enter on the Claude column (see
// isClaudeChatFocused above, mirrors commentCommandsFor's
// own role for the comment column). "Wis Claude-gesprek" runs STRAIGHT AWAY
// on the first Enter — no confirm step (reviewer request) — EXCEPT while the
// conversation's shadow worktree still holds pending agentic-edit work, the
// one case where clearing loses something that isn't recoverable: then, and
// only then, it keeps its confirm submenu (claudeChatClearConfirmCommandsFor)
// naming what would be lost; "Probeer de mislukte turn opnieuw" runs
// straight away (it re-runs one failed turn, nothing destructive) and is the
// keyboard twin of the "Opnieuw proberen" button on the failed bubble itself
// (ClaudeChat.mjs) — same function either way, per
// .claude/docs/mouse-navigation.md. It is listed unconditionally: the
// workflow ignores the Signal when no turn failed, which is cheaper than
// teaching this menu to inspect the transcript.
//
// A third, conditional item — "Comment hiervan maken" — sits BETWEEN those
// two whenever claudeAnchorIsPlaceholder() (the anchor comment never got the
// reviewer's own text): reviewer request, reached the same way as the empty
// composer's Enter (see the widened isClaudeChatFocused() gate in onKeydown).
// A comment that already carries real text offers no such item — there is
// nothing left to "make a comment of", it already is one.
//
// ORDER IS LOAD-BEARING: withClose pins "Sluit menu" at index 0 and defaultSel
// starts the selection on index 1, so whatever comes FIRST here is the default
// Enter action. That must stay "Wis Claude-gesprek" — the item that means
// something in every state. The retry only
// means something after a turn finally failed; anywhere else it is a silent
// no-op, so it must never be what a reflexive second Enter runs. Putting it
// first broke exactly that (tests/claude-chat-panel.spec.mjs's
// "Wis Claude-gesprek" spec pressed Enter and got the no-op instead of the
// clear). "Comment hiervan maken" is inserted after it (not first)
// for the same reason — it only means something on a still-empty anchor.
function claudeChatCommandsFor() {
  const shadowWarning = claudeChatShadowWarning()
  const items = [
    {
      id: 'clear-claude-chat',
      label: t('Wis Claude-gesprek'),
      hint: 'wis',
      ...(shadowWarning
        ? { children: claudeChatClearConfirmCommandsFor(shadowWarning) }
        : { run: () => runClearClaudeChat() }),
    },
  ]
  if (claudeAnchorIsPlaceholder()) {
    items.push({
      id: 'convert-claude-anchor',
      label: t('Comment hiervan maken'),
      hint: 'comment',
      run: () => convertClaudeAnchorToComment(),
    })
  }
  items.push({
    id: 'retry-claude-turn',
    label: t('Probeer de mislukte turn opnieuw'),
    hint: 'opnieuw',
    run: () => retryClaudeTurn(),
  })
  // "Stop deze Claude-beurt" — keyboard twin of the Stop button next to
  // claude-chat-status (CommentClaudeFooter, RelatedPanel.mjs), same
  // cancelClaudeTurn() call either way, per
  // .claude/docs/mouse-navigation.md. Listed unconditionally, same
  // reasoning as "retry-claude-turn" right above it: POST /api/chat/cancel
  // is a silent no-op when nothing is running, cheaper than teaching this
  // menu to inspect chat_progress state. Deliberately LAST, never first —
  // defaultSel starts on the first real item and a reflexive Enter must
  // never land on "stop" while nothing is running.
  items.push({
    id: 'cancel-claude-turn',
    label: t('Stop deze Claude-beurt'),
    hint: 'stop',
    run: () => cancelClaudeTurn(),
  })
  return withClose(items)
}

// checkoutChipCommandsFor — Enter/click on the checkout chip in prInfoCard.
// Dynamic, built fresh on every open (mirrors pushTodoConfirmCommands): a
// pending chatCheckoutDecision (whichever stage — chooseDirectory,
// reuseMerged, dirtyTree, divergedHistory, see chat_checkout.go) offers its
// own Options as commands, each answered via the SAME "checkoutAnswer"
// Action a chat-driven answer already uses — one mechanism, two entry
// points. With nothing pending, the root action is "andere directory
// kiezen" ("opnieuw zoeken" was dropped: with no cache to bypass, it would
// do nothing a bare relist doesn't already do). "Nu terugzetten" only
// appears while a stash is actually waiting; "Uit" is always offered last.
function checkoutChipCommandsFor() {
  const c = state.checkout || {}
  const items = []
  const decision = c.decision
  if (decision && Array.isArray(decision.options) && decision.options.length) {
    decision.options.forEach((opt, i) => {
      items.push({
        id: 'checkout-opt-' + i,
        label: opt,
        hint: 'kies',
        run: () => sendCheckoutAction('checkoutAnswer', opt),
      })
    })
  } else {
    items.push({
      id: 'checkout-choose',
      label: t('Andere werkmap kiezen'),
      hint: 'kies',
      run: () => sendCheckoutAction('checkoutRelist'),
    })
  }
  if (c.stashPending) {
    items.push({
      id: 'checkout-restore-stash',
      label: t('Nu terugzetten (eerder opgeslagen wijziging)'),
      hint: 'stash',
      run: () => sendCheckoutAction('checkoutRestoreStash'),
    })
  }
  items.push({
    id: 'checkout-off',
    label: t('Uit (geen werkmap koppelen)'),
    hint: 'uit',
    run: () => sendCheckoutAction('checkoutOff'),
  })
  return withClose(items)
}

// pushTodoConfirmCommands — the one-more-step confirm submenu behind the
// push-todo row (mirrors claudeChatClearConfirmCommandsFor): pushing writes to
// a branch other people work on, so it never fires on the first Enter. Built
// fresh each open so the label can name the branch and the commit count the
// read model currently reports.
function pushTodoConfirmCommands() {
  const p = state.pendingPush || {}
  const n = p.ahead || 0
  const branch = p.headRef || t('de PR-branch')
  return withClose([
    {
      id: 'push-pending-confirm',
      label: t(n === 1 ? 'Ja, push {n} commit naar {branch}' : 'Ja, push {n} commits naar {branch}', { n, branch }),
      hint: 'bevestig',
      run: () => pushPendingWork(),
    },
  ])
}

// pushTodoCommandsFor — the root list for Enter on the push-todo row at the
// bottom of the index. One command, gated behind the confirm submenu above; a
// previous failure is named in the label so the reviewer knows a retry is what
// he is confirming.
function pushTodoCommandsFor() {
  const p = state.pendingPush || {}
  const retry = p.state === 'failed'
  return withClose([
    {
      id: 'push-pending',
      label: retry ? t('Push opnieuw naar GitHub') : t('Push naar GitHub'),
      hint: 'push',
      children: pushTodoConfirmCommands(),
    },
  ])
}

// isOwnComment reports whether `c` (a raw comment row, e.g. selectedComment()
// or focusedComment()) was written by the current reviewer — either placed IN
// THIS APP (an in-app comment stores no explicit Source at all: createComment
// in RelatedPanel.mjs sends no `source` field, so it's stored as the Go
// zero-value "" and then OMITTED from the JSON response entirely via
// `json:"source,omitempty"` on comments.Comment — so `c.source` is `undefined`
// for a normal own comment, not the string 'ui'; this mirrors the `c.source ||
// 'ui'` normalization already used elsewhere, e.g. threadMessages/
// commentActivitySummary in RelatedPanel.mjs) OR placed BY THE REVIEWER
// DIRECTLY ON GITHUB and later imported (source 'github' + author ===
// meLogin(), see avatar.mjs). meLogin() is '' until ensureMe() resolves
// (awaited before cs.list is ever populated, see loadComments in
// RelatedPanel.mjs) — until then a github-sourced comment simply counts as
// "not mine", same as any other unresolved/offline lookup. Deliberately
// excludes `source === 'ai'` (a code_warning finding, author "AI check") —
// that's disjoint from both cases above, so there's no overlap with the
// "Comment hiervan maken" branch below.
//
// NOTE for whoever tests this: the github+meLogin() branch can't currently be
// exercised in the Playwright harness — there is no seed hook (unlike e.g.
// SLASH_JIRA_ASSIGNED for jira.Fake) to give the offline github.Fake a
// current user, so GET /api/me always answers {ok:false} there and meLogin()
// is always ''. Adding such a hook is a separate, small task if ever needed;
// this branch is exercised by reasoning/code review, not by an automated
// test.
function isOwnComment(c) {
  if (!c) return false
  if (!c.source || c.source === 'ui') return true
  return c.source === 'github' && !!meLogin() && c.author === meLogin()
}

// prCommentCommandsFor builds the small action menu for a selected
// comment-index item (Enter on a sidebar row with kind:'comment' — see
// selectedComment/recomputeLeftList; → instead steps into the item's own
// thread, see enterPrCommentThread in RelatedPanel.mjs). The order of the two
// core items — "Beantwoorden" and "Resolve comment" — depends on
// isOwnComment(c): for the reviewer's OWN comment, "Resolve comment" comes
// first (and is thus the default-selected item, see defaultSel/withClose) —
// on your own comment, resolving is the more likely first action; for
// anyone else's comment "Beantwoorden" stays first/default, as before. Both
// items are ALWAYS present regardless of ownership, just reordered.
// "Beantwoorden" only reveals the reply textarea in the detail card to the
// right of the index (startPrCommentReply, RelatedPanel.mjs); the reviewer
// then types and sends from there, not from this menu. "Resolve comment"
// resolves the thread via the existing reply Signal (done:true,
// RelatedPanel.mjs's resolvePrCommentItem) — the same write path as the
// block-scoped "Resolve comment" command above, just against this item's own
// comment instead of cs's selected one. On an ALREADY resolved thread that
// same slot reads "Unresolve comment" instead (isResolvedComment →
// unresolvePrCommentItem) — never both, so the ordering rule above is
// unaffected. For an AI finding (isAiComment) neither exists: the list is
// [Beantwoorden, Verwijder comment], so "Beantwoorden" is the default there
// regardless of the ownership rule (an AI finding is never "own" anyway).
// "Verwijder comment" follows both, always last of the three and
// never the default (see deleteItem below).
//
// "Comment hiervan maken" — only appears for an AI-authored finding
// (source === 'ai'). This sidebar item can be EITHER a genuinely PR-wide,
// unanchored finding OR a line-anchored one that also gets its own
// "Comments op regels" row (commentBlockItem's b.lineAnchored) — selecting
// either still opens this exact menu (selectedComment()/openMenu('prComment')
// below), but only a PR-wide one has no underlying block to show: a
// line-anchored item's own detail view still drills into its real block (see
// DetailPanel), so THAT case reuses the same "+ Nieuwe comment" composer
// commentCommandsFor's own item below opens (convertWarningToComment, keeps
// the finding's full anchor via warningOverride) — a guard that instead
// required `c.kind` here (rejecting exactly that case) is what silently
// no-opped this whole action for a line-anchored finding: filled reply
// field, menu, then nothing at all. A genuinely PR-wide finding (`c.kind`
// set) still goes to convertPrWideWarningToComment, which repurposes this
// item's own "Beantwoorden" field instead (RelatedPanel.mjs). Placed right
// after the two core items (never first) — an AI finding is never "own"
// (isOwnComment excludes source 'ai'), so this can never collide with the
// reordering above.
function prCommentCommandsFor() {
  const c = selectedComment()
  const replyItem = {
    id: 'pr-comment-reply',
    label: t('Beantwoorden'),
    hint: 'reply',
    run: () => startPrCommentReply(selectedComment()),
  }
  const resolveItem = isResolvedComment(c)
    ? {
        id: 'pr-comment-unresolve',
        label: t('Unresolve comment'),
        hint: 'heropen',
        run: () => {
          const sel = selectedComment()
          if (sel) unresolvePrCommentItem(sel)
        },
      }
    : {
        id: 'pr-comment-resolve',
        label: t('Resolve comment'),
        hint: 'resolve',
        run: async () => {
          const sel = selectedComment()
          if (!sel) return
          const wasCommentIndexRow = isCommentIndexRowActive()
          const beforeIdx = state.selected
          await resolvePrCommentItem(sel)
          await afterResolveAction(wasCommentIndexRow, beforeIdx)
        },
      }
  // "Verwijder comment" — the same delete Signal the block-scoped menu has
  // always offered (deleteFocusedComment), which this menu lacked entirely:
  // an AI risk finding that couldn't be pinned to a block could be resolved
  // but never removed, even though the backend supported it all along
  // (reported bug: "ik kan ai waarschuwing niet resolven of verwijderen").
  // Always after the two core items, never first/default — it is destructive,
  // and Resolve/Beantwoorden stay the likely first action.
  const deleteItem = {
    id: 'pr-comment-delete',
    label: t('Verwijder comment'),
    hint: 'delete',
    // This menu is only ever reached with a comment-index row selected (Enter
    // directly on the row) — always afterCommentRowRemoved, never the
    // ordinary-code fallback, same "in de blokken index bezig" reasoning as
    // deleteCommentAndSelectRow's own gate.
    run: async () => {
      const sel = selectedComment()
      if (!sel) return
      const beforeIdx = state.selected
      await deletePrCommentItem(sel)
      await afterCommentRowRemoved(beforeIdx)
    },
  }
  // An AI finding (isAiComment) gets NO resolve/unresolve item at all — see
  // that helper's own doc comment. It is never "own" either, so the list is
  // simply [Beantwoorden, Verwijder]: replying stays the default, deleting
  // stays out of first place.
  const items = isAiComment(c)
    ? [replyItem, deleteItem]
    : isOwnComment(c)
      ? [resolveItem, replyItem, deleteItem]
      : [replyItem, resolveItem, deleteItem]
  // "Bewerk bericht" edits whichever message the keyboard is currently ON in
  // this item's own thread (→/enterPrCommentThread + pct, see
  // focusedPrThreadMessage) — only for the reviewer's OWN message.
  const msg = focusedPrThreadMessage(c)
  if (isOwnMessage(msg)) {
    items.push({
      id: 'pr-comment-edit',
      label: t('Bewerk bericht'),
      hint: 'edit',
      run: () => startEditMessage(selectedComment(), msg),
    })
  }
  if (c && c.source === 'ai') {
    items.push({
      id: 'pr-comment-from-warning',
      label: t('Comment hiervan maken'),
      hint: 'convert',
      run: () => (c.kind ? convertPrWideWarningToComment(c) : convertWarningToComment(c)),
    })
  }
  // "Chat met Claude" — reviewer request: chat about THIS PR-wide item (an
  // AI-controle finding, or any other comment-index item) right away, without
  // a code context to hang a → chain off (unlike a block-scoped comment,
  // which already reaches Claude via →, see claude-chat-panel.md). Opens the
  // embedded column startPrCommentChat reveals under this item's own detail
  // card (RelatedPanel.mjs). Always present, regardless of source/ownership —
  // there's nothing here that would make chatting inappropriate.
  items.push({
    id: 'pr-comment-claude-chat',
    label: t('Chat met Claude'),
    hint: 'claude',
    run: () => startPrCommentChat(selectedComment()),
  })
  if (needsPublishChoice(c))
    items.push(publishThreadCommand(c, (withHistory) => publishPrCommentAndExit(c, withHistory)))
  items.push({
    id: 'pr-comment-ignore',
    // Label is a function so it names the current state (resolveLabel/
    // snapshotCommands read it ONCE, right now, when the menu opens — see
    // that comment for why this must never become a live binding).
    label: () => (isIgnoredComment(state, curBlock()) ? t('Ignore ongedaan maken') : 'Ignore'),
    hint: 'ignore',
    run: () => toggleIgnoreComment(selectedComment()),
  })
  return withClose(items)
}

// toggleIgnoreComment flips whether a PR-comment index item (kind:'comment')
// is hidden from the "PR-comments" section — a SEPARATE flag from "resolved"
// (which already folds a comment into the *approved* section, see
// blockApproveCount/isFullyApproved's comment-item branch). Durable, like
// resolve/delete/reply: the local map is reassigned first so the row
// disappears immediately (optimistic), and the decision is then written
// through the ignore_comment tracker's Signal — the sanctioned write path.
// Offline (no ignoreRunId) that Signal is a no-op and the toggle degrades to
// session-only. Reassigns state.ignoredComments wholesale so arrow.js
// re-renders (never mutated in place, per the arrow.js reactivity rule).
function toggleIgnoreComment(c) {
  if (!c) return
  const id = 'comment:' + c.id
  const next = { ...state.ignoredComments }
  const ignored = !next[id]
  if (ignored) next[id] = true
  else delete next[id]
  state.ignoredComments = next
  persistIgnoredComment(c.id, ignored)
}

// COMPOSE_COMMANDS — shown when Enter (or the composer button) is pressed on a
// filled new-comment composer that is CONVERTING an AI-controle finding
// (isConvertingAiWarning() — the composer opened via "Comment hiervan maken",
// RelatedPanel.mjs's warningOverride): choose what to do with the typed text.
// "Sluit menu" is pinned first (withClose); the menu opens on the 2nd item
// (defaultSel), where "Plaats comment" (the default action, and now the only
// real "place it" item) posts a normal, public comment (the plain
// placeComment path, no opts.local) so the plain "type, Enter, Enter" flow
// still places a real comment. The Claude/Git/Jira items are placeholders
// (like the Jira items in PR_COMMANDS). "Plaats comment" refreshes the Taken
// column right after (pollWorkflows) — task_code_comment starts a new
// workflow run per comment, and this is more immediate than waiting for the
// next WORKFLOWS_POLL_MS tick. The Git label names the current selection unit
// (groep/regel/call) via granNoun.
//
// An ORDINARY composer (not converting a finding) skips this menu entirely —
// Enter/the "Plaats…" button call runComposePost() straight away, see the
// Enter branch in onKeydown and the InlineComments openCompose callback
// below. Reviewer request: only a conversion is worth the extra look before
// it becomes public; a plain new comment — even one on a line that happens
// to already carry an unrelated AI warning — should just post.
//
// There used to be a second real item here, "compose-self"/"Alleen voor
// mijzelf" (placeComment(..., {local:true}) — a private note the workflow
// never posts to GitHub, see the `Local` input in
// .claude/docs/workflows-comments.md). Removed on request ("dat gebruik ik
// niet meer") — this was the ONE UI entry point that let the reviewer choose
// to keep a brand-new root comment private; `placeComment`'s `opts.local`
// parameter itself stays (shared, generic plumbing — `ensureClaudeAnchorForNew`,
// RelatedPanel.mjs, still always creates its Claude-chat anchor comment with
// `local:true`, and the PR-wide branch still honours `opts.local` for any
// future/API caller). `replyPublishCommandsFor`'s own "Alleen voor mijzelf
// (blijft lokaal)" reply item (keeping an existing thread's REPLY local, not
// creating a new private root) was a DIFFERENT feature and outlived this one
// for a while, but has since been removed too, on the same kind of request —
// see that function's own doc comment. See "The compose (comment-kind) menu"
// in .claude/docs/command-palette.md.
// runComposePost places the typed comment and refreshes/re-aligns the UI
// after — the one real "post it" action, shared by COMPOSE_COMMANDS' own
// "Plaats comment" item and the Enter/"Plaats…"-button shortcut below that
// skips the menu outright for an ordinary (non-conversion) composer. Keeping
// this as a single function is what makes "a click runs the same function a
// key runs" hold here too (see .claude/docs/mouse-navigation.md).
async function runComposePost() {
  await placeComment(state, commentTarget)
  pollWorkflows()
  // placeComment (RelatedPanel.mjs) already handed the keyboard back to
  // the diff (exitRelated) — re-align <main> on it, mirroring the same
  // scrollFocusIntoView() call onKeydown makes right after an ← exit out
  // of the sidebar (see the relatedActive() branch above).
  scrollFocusIntoView()
}

const COMPOSE_COMMANDS = withClose([
  {
    id: 'compose-post',
    label: t('Plaats comment'),
    hint: 'post',
    run: runComposePost,
  },
  {
    id: 'compose-claude',
    label: t('Claude commando'),
    hint: 'todo',
    // Placeholder — no Claude command integration yet.
    run: () => {},
  },
  {
    id: 'compose-commit',
    label: () => t('Laat Claude dit implementeren ({noun})', { noun: t(granNoun()) }),
    hint: 'commit',
    // Placeholder — no git-commit/implement integration yet. The label refers to
    // the unit (group/line/call) the comment is scoped to.
    run: () => {},
  },
  {
    id: 'compose-jira',
    label: t('Jira'),
    hint: 'jira',
    // A submenu (see runCommand). All three are placeholders — no Jira write yet.
    children: withClose([
      { id: 'compose-jira-comment', label: t('Comment op ticket'), hint: 'todo', run: () => {} },
      { id: 'compose-jira-subtask', label: t('Subtaak aanmaken'), hint: 'todo', run: () => {} },
      { id: 'compose-jira-task', label: t('Nieuwe taak aanmaken'), hint: 'todo', run: () => {} },
    ]),
  },
])

// replyPublishCommandsFor — the follow-up menu shown when the reviewer sends a
// reply on a thread that has never touched GitHub (a private note, or an AI
// finding — see needsPublishChoice/openPublishMenu in RelatedPanel.mjs). The
// send is held until an item here runs it, so nothing reaches GitHub without
// this choice.
//
// There used to be a third, DEFAULT item here, "reply-publish-local"/"Alleen
// voor mijzelf (blijft lokaal)" (`sendPendingReply('', false)` — keeps the
// reply local, same as before this menu existed). Removed on request ("dat
// gebruik ik niet meer"), the same kind of removal `COMPOSE_COMMANDS` went
// through earlier for its own "Alleen voor mijzelf" item (see that constant's
// own doc comment) — `sendPendingReply`'s `publish: ''` branch and the
// backend's local-reply plumbing stay, generic and unused from here, exactly
// like `placeComment`'s `opts.local`. "Sluit menu" is pinned first
// (withClose) and defaultSel opens on the 2nd item, so **"Alleen mijn
// antwoord op GitHub" is now the default Enter action** — a bare "type,
// Enter, Enter" on a still-local thread now publishes just the typed reply
// straight away, instead of keeping it local. Confirmed acceptable
// (reviewer request, "Ja, prima" — the same shift `COMPOSE_COMMANDS` already
// went through when its own local item was removed).
//
// The two GitHub items only grow a submenu when there is actually an earlier
// local conversation to decide about (localReplies > 0) — asking "with or
// without the earlier messages?" on a thread that has none would just be an
// extra keypress for nothing. Built fresh at open time and every label is a
// plain string, so nothing that reads live state reaches CommandMenu's own
// (never disposed) reactive tree — see the disposal-gap note in
// arrowjs-pitfalls.md.
//
// A bare, still-untaken-over Claude-chat anchor thread (info.chatAnchor, see
// pendingPublishInfo in RelatedPanel.mjs) drops the second GitHub item
// entirely — its root is only the auto-generated placeholder sentence, never
// anything the reviewer wrote, so "Ook mijn comment op GitHub" would offer to
// publish that placeholder as if it were a real comment. Reported bug: a
// reviewer who started a Claude chat and sent their FIRST reply saw both
// GitHub items even though they "hadn't written a comment yet".
//
// In practice this menu never even OPENS for that case any more:
// sendReaction (RelatedPanel.mjs) now short-circuits a bare chat-anchor's
// first reply straight to `postThreadReply(c, body, 'reply', false)` — the
// immediate reviewer follow-up, "als ik eigenlijk maar 1 optie heb (- sluiten)
// dan wil ik geen menu zien": with the bogus item gone, only ONE real
// destination was left next to "Sluit menu", i.e. no actual choice. This
// branch stays as a defensive fallback (`isChatAnchor` can never be true here
// while reached only through the ordinary `needsPublishChoice` menu open) —
// see ".claude/docs/command-palette.md".
function replyPublishCommandsFor() {
  const info = pendingPublishInfo()
  const n = info ? info.localReplies : 0
  const isAI = !!info && info.source === 'ai'
  const isChatAnchor = !!info && info.chatAnchor
  const rootLabel = isAI ? t('Ook de AI-melding op GitHub') : t('Ook mijn comment op GitHub')
  const earlier = t(n === 1 ? 'de eerdere {n} bericht' : 'de eerdere {n} berichten', { n })
  // historyChoice turns one publish mode into its own with/without-the-earlier-
  // messages submenu; without earlier messages it stays a plain, directly
  // running item.
  const historyChoice = (id, label, publish) =>
    n === 0
      ? { id, label, hint: 'github', run: () => sendPendingReply(publish, false) }
      : {
          id,
          label,
          hint: 'github',
          children: withClose([
            {
              id: id + '-without-history',
              label: t('Zonder {earlier}', { earlier }),
              hint: 'alleen dit',
              run: () => sendPendingReply(publish, false),
            },
            {
              id: id + '-with-history',
              label: t('Met {earlier}', { earlier }),
              hint: 'hele gesprek',
              run: () => sendPendingReply(publish, true),
            },
          ]),
        }
  // A bare, un-taken-over Claude-chat anchor (info.chatAnchor) has no
  // reviewer-authored root text at all — only the auto-generated placeholder
  // sentence — so "Ook mijn comment op GitHub" is dropped entirely rather
  // than shown with a misleading label: see pendingPublishInfo's own doc
  // comment. The reviewer's reply is then the only thing this menu can ever
  // offer to publish.
  const items = [historyChoice('reply-publish-reply', t('Alleen mijn antwoord op GitHub'), 'reply')]
  if (!isChatAnchor) items.push(historyChoice('reply-publish-thread', rootLabel, 'thread'))
  return withClose(items)
}

// POSTAPPROVE_COMMANDS — shown right after a palette approve action (menu mode
// 'postApprove', see afterApproveAction) when there's a next not-yet-approved
// unit still ahead: continue straight to it, or just close. Only reached from
// the command-palette approve action — the top checkbox in Block.mjs stays a
// direct toggle and never opens this menu. "Sluit menu" is pinned first
// (withClose, with its own onClose so closing also drops the stashed
// postApproveTarget — mirrors the old dedicated close item's cleanup); the
// menu opens on the 2nd item (defaultSel), so this item stays the default
// Enter action — its POSITION (index 1, right after the pinned close item)
// never changes, only its label text.
const POSTAPPROVE_COMMANDS = withClose(
  [
    {
      id: 'postapprove-next',
      // A list-mode (`keepList`) approve never reaches this menu anymore — it
      // always jumps straight to the next unapproved block itself (see
      // afterApproveAction's EXCEPTION 2) — so this label only ever needs the
      // diff-mode wording. A LABEL FUNCTION (not the earlier plain string),
      // exactly the COMMANDS 'approve' item's pattern: resolved once by
      // resolveLabel/snapshotCommands at openMenu() time (never a reactive
      // binding reaching the CommandMenu tree, see
      // .claude/rules/arrowjs-pitfalls.md). "Ga terug" when the stashed
      // postApproveTarget is a RETURN-to-ancestor plan (findNextUnapproved's
      // `isReturn`, see there) — the reviewer just finished a drilled
      // column's whole subtree and this jumps back UP to an unapproved
      // ancestor, not forward to something new — otherwise the existing
      // "Ga door" wording for every other (forward) plan.
      label: () => (postApproveTarget && postApproveTarget.isReturn ? t('Ga terug') : t('Ga door')),
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

// ── "just praise" comments don't count as open points ──────────────────────
// A comment that only says "Nice"/"Goed"/"Lekker" leaves the PR author nothing
// to do, so counting it in the clipboard summary below ("✅ met N comments")
// overstates what still needs looking at. The word list comes from read-only
// GET /api/praisewords (the <dataDir>/praise-words.json override, else the
// server's built-in defaults — see praisewords.go), so a reviewer can add words
// without touching code.
const DEFAULT_PRAISE_WORDS = ['nice', 'goed', 'lekker']
let praiseWords = DEFAULT_PRAISE_WORDS

// ensurePraiseWords fetches the list once, at startup — buildReviewClipboardText
// is synchronous (it runs inside a click handler, after the submit already
// succeeded), so the value has to be there by then rather than awaited. A failed
// or slow fetch simply leaves the defaults in place, which is also what every
// offline/SLASH_GITHUB=off test run sees. Plain non-reactive module state: it is
// read at click time only, never rendered, so there is no arrow.js repaint
// concern (unlike `me`/`names` in avatar.mjs, see conventions.md).
function ensurePraiseWords() {
  fetch('/api/praisewords')
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((data) => {
      if (data && data.ok && Array.isArray(data.words) && data.words.length) praiseWords = data.words
    })
}

// threadLastBody is the body of the LAST message of a comment thread: its final
// reply if there is one, otherwise the comment's own body. `c.reactions` is
// already chronological (modules/comments orders reactions by created_at), so
// the last entry needs no sorting here.
function threadLastBody(c) {
  const replies = c.reactions || []
  return (replies.length ? replies[replies.length - 1].body : c.body) || ''
}

// isPraiseComment reports whether a thread has ended in meaningless praise, and
// therefore should not be counted as an open point.
//
// TWO DELIBERATE CHOICES, both explicitly agreed — do not "fix" either:
//
//  1. RAW SUBSTRING, no word boundaries. Any occurrence anywhere in the text
//     matches, so "Nice, maar deze query geeft N+1" is skipped too — and yes,
//     "goedgekeurd"/"goedkeuring" therefore match on "goed". Accepted: adding
//     \b would make the rule narrower than what was asked for.
//  2. Only the LAST message of the thread decides (threadLastBody), regardless
//     of who wrote it. The final message is the thread's current state: an
//     inhoudelijke comment closed off with "Goed, opgelost" is settled, while a
//     thread that opens with "Nice" but ends in a real question still counts.
//     Checking EVERY message would let one polite word mid-discussion hide a
//     thread forever.
function isPraiseComment(c) {
  const body = threadLastBody(c).toLowerCase()
  return praiseWords.some((w) => body.includes(w))
}

// ownOpenCommentCount counts the reviewer's OWN comments (isOwnComment, so
// placed in this app or on GitHub by the reviewer themselves — never someone
// else's, never a bot/AI finding) that are not (yet) resolved and are not just
// praise (isPraiseComment), across the WHOLE PR (commentListSnapshot(), not
// scoped to one block/subtree — the clipboard summary below is a PR-level
// review outcome, not a per-block one).
// Reused only by buildReviewClipboardText; a plain synchronous read of
// RelatedPanel.mjs's cs.list, exactly like prWideComments/commentRowSet.
function ownOpenCommentCount() {
  return commentListSnapshot().filter(
    (c) => isOwnComment(c) && c.status !== 'resolved' && !isPraiseComment(c)
  ).length
}

// buildReviewClipboardText renders the one-line summary the reviewer pastes
// elsewhere (Slack, a PR checklist, …) right after actually submitting a real
// GitHub review — see submitReview below. Deliberately no emoji for a
// rejection (only for an approve, where it doubles as a friendly "done"
// signal) — a reject already carries its own written reason, no icon needed.
function buildReviewClipboardText(event, body) {
  const link = state.prUrl || GITHUB_PR
  if (event === 'REQUEST_CHANGES') {
    // Collapse the typed reason to one line — a clipboard summary is meant to
    // stay short/pasteable, so only whitespace is normalized, the text itself
    // is never summarized or truncated.
    const reason = body.replace(/\s+/g, ' ').trim()
    return t('{link} met nog een paar aanpassingen: {reason}', { link, reason })
  }
  const n = ownOpenCommentCount()
  if (n === 0) return t('{link} ✅', { link })
  return t(n === 1 ? '{link} ✅ met {n} comment' : '{link} ✅ met {n} comments', { link, n })
}

// copyReviewSummary puts the text on the clipboard. Same minimal error
// handling as submitReview itself (no toast convention in this app, see
// conventions.md) — a failure (no clipboard permission, insecure context)
// just logs; the review itself already succeeded regardless.
async function copyReviewSummary(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch (err) {
    console.error('clipboard write failed:', err)
  }
}

// copySelectionCommand builds the native (right-click) context menu's
// "Kopieer selectie" item — see openMenu's own doc comment for when it's
// added at all. `text` is snapshotted once, at open time, so a later change
// to the page's selection (the menu itself takes no DOM focus away from it)
// never retroactively changes what a delayed click on this row would copy.
function copySelectionCommand(text) {
  return {
    id: 'copy-selection',
    label: t('Kopieer selectie'),
    hint: 'copy kopieer',
    run: () => copyReviewSummary(text),
  }
}

// dedentCode strips the leading whitespace SHARED by every non-empty line of
// a copied unit's code — reviewer request: "de geselecteerde regel kunnen
// kopiëren... zonder de leidende spaties". A single line simply loses its
// own indentation; a multi-line `group` unit keeps its RELATIVE nesting
// (only the common prefix goes), so a nested `if` inside the copied group
// doesn't get flattened onto the same column as its parent.
function dedentCode(code) {
  const lines = code.split('\n')
  let min = Infinity
  for (const line of lines) {
    if (!line.trim()) continue
    const leading = /^[ \t]*/.exec(line)[0].length
    if (leading < min) min = leading
  }
  if (!isFinite(min)) min = 0
  return lines.map((line) => line.slice(Math.min(min, line.length))).join('\n')
}

// copySelectedCode — "Kopieer deze regel" (COMMANDS): copies the source code
// of whichever navigation unit is currently focused (commentTarget's own
// gran/rowStart-scoped `code`, the same text "Comment op deze regel"/"Chat
// over deze regel" anchor to), minus its shared leading indentation
// (dedentCode) — reusing copyReviewSummary's existing clipboard mechanism,
// same as copySelectionCommand above. A codeless target (a block with no
// navigable unit, commentTarget's own `code: ''` fallback) is a no-op —
// there is nothing to copy.
async function copySelectedCode() {
  const t = commentTarget()
  if (!t || !t.code) return
  await copyReviewSummary(dedentCode(t.code))
}

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
// courtesy call compose-post already makes after placing a comment.
// It ALSO copies a one-line PR summary to the clipboard — but only after a
// genuinely successful submit (a failed fetch returns before this).
async function submitReview(event, body = '') {
  try {
    const res = await fetch('/api/workflows/submit_review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr, repo: state.repo || undefined, event, body }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('submit_review failed:', res.status, text)
      return
    }
    pollWorkflows()
    await copyReviewSummary(buildReviewClipboardText(event, body))
  } catch (err) {
    console.error('submit_review network error:', err)
  }
}

// REVIEW_APPROVE_CONFIRM_COMMANDS — the one-more-step confirmation opened by
// choosing "Keur de HELE PR goed" below (via the ordinary `children`
// submenu mechanism runCommand already uses for e.g. "Open GitHub" — no new
// menu mode needed). This exists because approving the whole PR (a real
// GitHub review, submitReview('APPROVE')) used to fire on that single first
// choice — reported as "too easy to approve the whole PR by accident".
// "Sluit menu" is pinned first (withClose); the menu opens on the 2nd item
// (defaultSel), so a reviewer who really means it can still confirm with one
// more Enter — but it is a genuinely separate keypress/click from the one
// that opened this submenu, not the same one.
// TWO confirm items, both submitting the exact same review — they differ only
// in where the reviewer ends up afterwards. Finishing a PR is almost always
// followed by picking up the next one, so "en ga naar overzicht" is the
// DEFAULT (the 2nd item, i.e. the one Enter lands on); "en sluiten" stays for
// a reviewer who wants to keep looking at this PR. The navigation deliberately
// happens only AFTER the submit resolved (submitReview also copies the summary
// to the clipboard on success), and uses overviewExitUrlAfterApprove() —
// NOT overviewExitUrl() — so the PR just approved is already filtered out of
// the overview's list by the time it renders, with the top remaining row
// selected instead of this (now finished) one; see `approvedPr`/
// `trySelectTopAfterApprove` in overview.mjs.
const REVIEW_APPROVE_CONFIRM_COMMANDS = withClose([
  {
    id: 'review-approve-confirm-overview',
    label: t('Goedkeuren en ga naar overzicht'),
    hint: 'overzicht',
    icon: 'approve-pr',
    run: async () => {
      await submitReview('APPROVE')
      location.href = overviewExitUrlAfterApprove()
    },
  },
  {
    id: 'review-approve-confirm-close',
    label: t('Goedkeuren en sluiten'),
    hint: 'bevestig',
    icon: 'approve-pr',
    run: () => submitReview('APPROVE'),
  },
])

// startBatchFromRow is the bottom action row's Enter/click action (see
// onBatchRow and the batchRowFocused Enter branch below): confirm the run
// over exactly the CHECKED comments (checkedBatchComments, BlockList.mjs —
// unchecking a row is the curation step, so there is no separate confirm
// submenu here, unlike the push-todo row) and immediately put the reviewer
// on the FIRST checked comment, where the pulsing pill and the log line show
// what Claude is doing (his own request: "na het verwerken van de comments
// moet je gaan naar de eerste comment in de lijst"). A refused start
// (already running, network) or an empty selection leaves things as they are.
//
// This replaces the removed 'bulkComments' palette entry point
// (REVIEW_BATCH_COMMENTS_ITEM) — deliberately with no replacement shortcut in
// the review-submit menus: the action row is now always visible in the
// sidebar whenever there's something to batch, which already covers that
// entry point (explicitly agreed, see comments-panel.md).
async function startBatchFromRow() {
  const items = checkedBatchComments(state)
  if (!items.length) return
  const ok = await startCommentBatch(state.pr, items.map((c) => c.id))
  if (!ok) return
  pollWorkflows()
  jumpToCommentRow(items[0].id)
}

// jumpToCommentRow lands the sidebar selection on one comment's own index row.
// Every open comment has such a row (see indexComments in RelatedPanel.mjs), and
// the row may still be a poll tick away, which is exactly what blockRefPending +
// applyCommentRefRestore's retry already solve for `?sel=comment:<id>`.
function jumpToCommentRow(commentId) {
  blockRefPending = 'comment:' + commentId
  applyCommentRefRestore()
}

// REVIEW_APPROVE_COMMANDS — shown right after a palette approve action leaves
// the WHOLE PR fully approved (state.approvalTotal.done === total, over every
// top-level block plus its nested/drilled PR-block children — see
// afterApproveAction): there's nothing left to review anywhere, so offer to
// submit a real "approve" GitHub review, or just close. Choosing "Keur de
// HELE PR goed" does NOT submit directly (see REVIEW_APPROVE_CONFIRM_COMMANDS
// above) — it opens a one-item confirm submenu instead, so approving the
// whole PR always takes two deliberate choices. The item also carries a
// small check-in-circle icon (commandIcon in CommandMenu.mjs) as an extra,
// non-color cue that this action's scope is the WHOLE PR — the icon's SHAPE
// plus the label text carry that meaning, the emerald tint is decoration on
// top only (colorblind rule). "Sluit menu" is pinned first (withClose); the
// menu opens on the 2nd item (defaultSel), so "Keur de HELE PR goed" stays
// the default Enter action (which now opens the confirm submenu, not the
// review itself).
const REVIEW_APPROVE_COMMANDS = withClose([
  {
    id: 'review-approve-pr',
    label: t('Keur de HELE PR goed'),
    hint: 'approve',
    icon: 'approve-pr',
    children: REVIEW_APPROVE_CONFIRM_COMMANDS,
  },
])

// REVIEW_CHOICE_COMMANDS — shown right after a palette approve action leaves
// nothing ahead to navigate to (findNextUnapproved()===null — the reviewer
// just approved the last unit reachable from here) while the PR is NOT yet
// fully approved overall (something else — earlier, or elsewhere in the tree
// — is still open). Offers the same "Keur de HELE PR goed" as above (also
// via the REVIEW_APPROVE_CONFIRM_COMMANDS submenu, not a direct submit — see
// its doc comment), or "Wijs de PR af": that doesn't submit straight away (a
// REQUEST_CHANGES review needs a non-empty reason, see submitReview) but
// opens the dedicated free-text follow-up step instead (menu mode
// 'reviewReject' below) — that mandatory-reason step already is its own
// deliberate extra action, so it needed no additional confirm layer here.
// Both items carry an icon (commandIcon in CommandMenu.mjs) — a check-in-
// circle for approve, an X-in-circle for reject — so the two opposite
// choices are told apart by SHAPE, not only by the emerald/rose tint
// (colorblind rule: the tint is decoration on top only). "Sluit menu" is
// pinned first (withClose); the menu opens on the 2nd item (defaultSel), so
// "Keur de HELE PR goed" stays the default Enter action.
const REVIEW_CHOICE_COMMANDS = withClose([
  {
    id: 'review-choice-approve',
    label: t('Keur de HELE PR goed'),
    hint: 'approve',
    icon: 'approve-pr',
    children: REVIEW_APPROVE_CONFIRM_COMMANDS,
  },
  {
    id: 'review-choice-reject',
    label: t('Wijs de PR af'),
    hint: 'reject',
    icon: 'reject-pr',
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
// `when` (optional) is evaluated here too, and for the same reason as the label:
// an item that must disappear on a condition gets dropped ONCE, from plain
// non-reactive code, instead of leaving a live predicate inside CommandMenu's
// never-disposed tree. Recursing into `children` means a submenu item is
// filtered too.
function snapshotCommands(list) {
  return list
    .filter((c) => !c.when || c.when())
    .map((c) => ({
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

// curTestClassRow returns the selected test_class row (see
// testClassRowItem/recomputeLeftList) — null for any other selection. The
// single check every other test-class helper below builds on.
function curTestClassRow() {
  const b = state.blocks[state.selected]
  return b && b.kind === 'test_class' ? b : null
}

// isTestColumnActive reports whether stop 2b of the left→right nav chain
// (the methodes-kolom, see TestMethodsColumn.mjs) currently owns ↑/↓/→/Enter
// — only meaningful in list mode, on a selected test_class row, once the
// reviewer has actually stepped into the column (see enterDiff's own
// test_class branch, which flips state.testColumnFocused on the FIRST →).
function isTestColumnActive() {
  return state.mode === 'list' && state.testColumnFocused && !!curTestClassRow()
}

// stepTestColumnRow moves the methodes-kolom cursor by `dir` (1 = down, -1 =
// up): step within the active class's own methods, or — at the class edges —
// exit back to the index and land on the next/previous VISIBLE row (never
// across into a further class's methods, see stepTestMethod's own doc comment
// above for why the diff-mode flow-through is a deliberately separate
// mechanism). Shared by the plain ArrowDown/ArrowUp handling below and by a
// plain Enter with no active multi-selection (see the Enter branch's own
// isTestColumnActive() case) — reviewer request: "als ik enter druk, wil ik
// dat de volgende blokken test index blok item wordt geselecteerd, dus dat ik
// hetzelfde ziet als naar beneden." An active Shift+↓ range still opens
// "Keur deze N methodes goed" on Enter instead (hasMultiSelection()), so this
// helper is never called for that case.
function stepTestColumnRow(dir) {
  const row = curTestClassRow()
  const nextMethod = state.classMethodSel + dir
  if (row && nextMethod >= 0 && nextMethod < row.methods.length) {
    state.classMethodSel = nextMethod
    scrollSelectedIntoView()
    return
  }
  const next = stepVisibleSelected(dir)
  if (next !== state.selected) {
    // selectRow resets classMethodSel/testColumnFocused, so the index
    // (stop 2) owns the keyboard again after landing.
    selectRow(next)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
  }
}

// curBlock resolves the top-level selection to the block that actually owns
// the diff/approve/comment machinery: for an ordinary row that's simply
// state.blocks[state.selected], but for a test_class row (see
// testClassRowItem/recomputeLeftList) it's the ACTIVE method within it
// (state.classMethodSel) — a real PR block, so every existing block-centric
// mechanism (ensureCode, blockRows, approve, comments, drilling, footer,
// call-arrows) keeps working unchanged on whichever method is currently
// selected, without any of those needing to know test classes exist. Only
// the handful of functions that step BETWEEN top-level state.blocks entries
// (sameFileNeighbour/stepBlock, the sidebar's own ↑/↓) still read
// state.blocks[state.selected] directly, on purpose — see their own comments.
function curBlock() {
  const row = curTestClassRow()
  return row ? row.methods[state.classMethodSel] || null : state.blocks[state.selected]
}

// isActiveCard reports whether `b` — a block object a DetailPanel card closure
// has captured (for a test_class row, already the resolved ACTIVE method, see
// curBlock()'s own comment) — is the one currently selected, by IDENTITY
// (`b === curBlock()`) rather than by the render-loop position it happened to
// be built at. Mirrors conventions.md's "snapshot a selection by stable ID,
// never by raw array index" rule, applied to the DetailPanel's own per-card
// reactive opts (activeGroup/hintsEnabled/diffActive/viewMode in the
// pair.forEach loop below): those closures capture the render's own `i`
// (`state.blocks`' index at build time) as a plain lexical variable, but stay
// mounted — and keep firing reactively — for as long as the card's `.key(...)`
// stays unchanged, which it deliberately does across a pure reindex (the key
// only encodes ROLE — selected vs. preview — plus code/focus/file/label/side,
// never the numeric position, so a row that merely moves index while staying
// selected is patched in place rather than torn down and rebuilt). Comparing
// the frozen `i` against a freshly-read `state.selected` then goes stale the
// moment recomputeLeftList() (loadRelations/loadCallResolve/loadTestCovers/
// the comment poll, all of which can legitimately reindex the still-selected
// row right after a `?sel=`/`?tmethod=` restore) settles on a different index
// for the same row — `i === state.selected` is then wrong FOREVER (nothing
// else ever re-triggers that binding), silently and permanently dropping the
// active-row highlight with no error. `curBlock()` re-resolves through
// state.selected/state.classMethodSel fresh on every call, so comparing `b`'s
// own object identity against it is correct regardless of which index this
// particular closure invocation happened to freeze on. Reported bug + repro:
// tests/testclass-restore-reindex.spec.mjs.
function isActiveCard(b) {
  return b === curBlock()
}

// unanchoredCommentSelected — this file's OWN mirror of RelatedPanel's
// isPrCommentScope(), computed directly from focusedBlock() rather than by
// delegating to it. Deliberately NOT calling isPrCommentScope() here:
// cs.scope is reassigned on every f/d/s granularity step (the commentScope
// watch's own deps include state.change/gran, needed so RelatedPanel's
// comment filtering follows the cursor within an ordinary block) — a DOM
// class-attribute binding that reactively reads isPrCommentScope() therefore
// re-writes (and gets flagged as a mutation) on every such step even for an
// ordinary block, where the boolean itself never actually changes. Regression
// caught by tests/navigate.spec.mjs's "only patches the highlight, not the
// whole card" — see .claude/docs/comments-panel.md's own note on this.
function unanchoredCommentSelected() {
  const b = focusedBlock()
  return !!(b && b.kind === 'comment')
}

// blockShortcutHints — the contextual key-hint line under the active diff
// card (ShortcutHintBar, Block.mjs) — reviewer request: "onder elke kaart
// wil ik een lijn met hints wat je op dat moment voor keys kan typen".
// Deliberately trimmed to the handful of keys most reviewers actually reach
// for, not an exhaustive transcription of every documented micro-state (see
// .claude/docs/keyboard-navigation.md for the full picture) — a card this
// dense would defeat the point of a quick hint line. Empty once the keyboard
// has moved into the related panel (relatedActive()): that panel shows its
// own hints instead (see RelatedPanel.mjs's commentClaudeShortcutHints).
function blockShortcutHints() {
  if (relatedActive()) return []
  if (state.mode === 'list') {
    return [
      { key: '→', label: 'in diff/thread' },
      { key: 'Enter', label: 'menu' },
      { key: 'Space', label: t('goedkeuren + door') },
      { key: '/', label: 'PR-menu' },
    ]
  }
  // At 'line'/'call' the s/d/f zoom keys ARE the whole story — reviewer
  // request: "als je line hebt geselecteerd, laat dan niets zien behalve
  // sdf... als het een call is, laat dan alleen s, d, f omschrijven, de rest
  // mag dan weg" — so ←→/a/Space/Enter drop out entirely there, and each of
  // s/d/f gets its OWN entry+label ("omschrijf... los van elkaar") instead
  // of one combined 'f/d/s' key under a single "zoom" label. Listed in
  // KEYBOARD order (reviewer follow-up: "dit moet in volgorde van je
  // keyboard: s d f") — s, then d, then f — not in "which key does what"
  // order. `d` still only appears while genuinely usable (dHintUsable,
  // unchanged reasoning/scope).
  if (currentGran() !== 'group') {
    const items = [{ key: 's', label: t('uitzoomen') }]
    if (dHintUsable()) items.push({ key: 'd', label: t('terug') })
    items.push({ key: 'f', label: t('inzoomen') })
    return items
  }
  // At 'group', `s` is ALSO a no-op (already the coarsest level — the same
  // reasoning as `d`'s own dHintUsable gate above) — reviewer follow-up:
  // "bij een groep mag s weg" — so the combined key drops to just `f`
  // (labelled "Ga dieper": it's the only zoom key left that does anything).
  // Order: weergave, Ga dieper, kolom — reviewer follow-up on the ordering
  // and the label itself.
  return [
    { key: 'a', label: t('weergave') },
    { key: 'f', label: t('Ga dieper') },
    { key: '←→', label: t('kolom') },
    { key: 'Space', label: t('goedkeuren + door') },
    { key: 'Enter', label: 'menu' },
  ]
}

// currentGran — the granularity actually in effect right now: the focused
// drilled column's own drillCursor entry (state.focusLevel > 0), else the
// top-level state.gran. Shared by blockShortcutHints (which stand shows) and
// dHintUsable (below) so the two can never read two different notions of
// "current gran".
function currentGran() {
  if (state.focusLevel > 0) {
    const cur = state.drillCursor[state.focusLevel - 1] || { change: 0, gran: 'group' }
    return cur.gran
  }
  return state.gran
}

// dHintUsable — mirrors dKey()'s own real no-op cases (read-only, no side
// effects): reviewer request, "laat d niet zien als je niet kan gebruiken
// (als een groep is geselecteerd)" — dKey() ultimately calls setGran(-1)/
// setDrillGran(level,-1) whenever it isn't stepping to a previous call, and
// both of those are a genuine no-op once already at the coarsest 'group'
// level (GRANS.indexOf('group') === 0, so `to === from`, see setGran's own
// doc comment) — the exact scenario the reviewer flagged. A TRANSLATION
// block (per-key navigation, no group/line/call distinction at all — see
// setGran's own TRANSLATION guard) never has a usable 'd' either. At any
// OTHER gran (including 'call', where 'd' either steps to a previous call or
// still zooms call→line) 'd' always does something, so this only needs to
// rule out the one genuinely inert case.
function dHintUsable() {
  const b = curBlock()
  if (!b) return false
  if (state.focusLevel === 0 && b.category === 'TRANSLATION') return false
  return currentGran() !== 'group'
}

// topLoadingActive drives TopLoadingBar (a fixed strip at the very top of the
// screen): true whenever the currently active top-level card's code hasn't
// arrived yet (`undefined` = not requested yet, `null` = ensureCode's fetch is
// in flight — see ensureCode's own doc comment). Restricted to
// `state.focusLevel === 0` (a drilled Onderliggende-code column loading its
// own code doesn't drive this — that column already shows its own inline
// loading state) and to an ordinary block (a synthetic `comment`/`test_class`
// row never fetches its own code, see ensureCode's early returns). Simple, on
// purpose: fires for ANY not-yet-loaded top-level block — a fresh page load,
// a manual ↓/click as much as the approve-triggered auto-advance
// (afterApproveAction/spaceKey) this was built for — no separate "was this an
// auto-advance" flag. See "A separate, always-visible progress bar" sibling
// note for TopLoadingBar in footer.md.
function topLoadingActive() {
  if (state.mode !== 'diff' || state.focusLevel !== 0) return false
  const b = curBlock()
  return !!b && b.kind !== 'comment' && b.kind !== 'test_class' && (b.code === undefined || b.code === null)
}

// selectedComment returns the underlying comment object when the currently
// selected sidebar item is a synthetic PR-wide-comment entry (kind:'comment',
// see recomputeLeftList/commentBlockItem) — null for an ordinary PR block.
// Such an item has no diff to step into: Enter opens its own small action
// menu (prCommentCommandsFor) instead of the block palette; → instead steps
// into the item's own thread (enterPrCommentThread, RelatedPanel.mjs) — see
// onKeydown's Enter/ArrowRight branches.
function selectedComment() {
  const b = curBlock()
  return b && b.kind === 'comment' ? b.comment : null
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

// topLevelActiveUnit — the { start, end } row range of `b`'s currently
// selected navigation unit at the TOP level (state.mode/gran/change/
// rangeAnchor), regardless of state.focusLevel: the same computation the
// top-level block card's own `activeGroup` opt uses (see the DetailPanel
// pair.forEach render loop below), pulled out so it can also feed the
// look-ahead preview's `fitCapCharsFor` cap (see diff-card.md, "fit follows
// only the selected unit") — that cap must track this unit even while the
// keyboard has drilled elsewhere, since the top card being capped against
// still renders (dimmed) at this exact selection. Falls back to the first
// change group in list mode (there's no active unit there), null for a block
// with no navigable changes at all (or no block).
function topLevelActiveUnit(b) {
  if (!b) return null
  if (state.mode !== 'diff') return groupsFor(b)[0] || null
  const units = unitsOf(b)
  return isRangeGran(state.gran) ? rangeUnit(units, state.change, state.rangeAnchor) : units[state.change] || null
}

// focusedActiveUnit — the active unit of whichever card currently owns the
// keyboard: topLevelActiveUnit(curBlock()) at focusLevel 0, or the focused
// drilled column's own cursor (state.drillCursor) at a deeper level — the
// same computation the drilled column's own `activeGroup` opt uses. Used to
// feed the drill-preview column's `fitCapCharsFor` cap (drillPreviewColumns,
// below), which is only ever mounted while a drilled column owns the focus.
function focusedActiveUnit() {
  if (state.focusLevel === 0) return topLevelActiveUnit(curBlock())
  const b = state.drill[state.focusLevel - 1]
  if (!b) return null
  const cur = state.drillCursor[state.focusLevel - 1] || { change: 0, gran: 'group' }
  const units = navUnitsOf(b, blockRows(b), cur.gran)
  return isRangeGran(cur.gran) ? rangeUnit(units, cur.change, cur.rangeAnchor) : units[cur.change] || null
}

// Keyboard column resize (`c` shrinks, `v` grows) — the keyboard counterpart
// of the resize handle's drag (see columnWidth.mjs / column-resize.md). Holds
// c/v on the FOCUSED column: whichever column focusedBlock() currently
// belongs to, i.e. the column that owns state.focusLevel — not necessarily
// the diff card at rest. So this reaches the same column whether the
// keyboard is sitting on that block's own diff, or already stepped further
// into its Underlying-code panel, an inline comment thread or the embedded
// Claude chat (relatedActive()) — deliberately broader than f/d/s/a, which
// stay diff-only (see the guard in onKeydown just below for why).
//
// activeKeyResize/lastTap are plain module-level state, not reactive — like
// `ms`/`menu` above, they only ever drive this one gesture and don't need to
// be observed by any template.
let activeKeyResize = null // { key: 'c'|'v', handle: ReturnType<startKeyResize> }
const lastTap = { c: { time: 0, short: false }, v: { time: 0, short: false } }
const KEY_RESIZE_TAP_MAX_MS = 250 // a press shorter than this counts as a "tap"
const KEY_RESIZE_DOUBLE_TAP_MS = 350 // max gap between two taps to count as a double-tap reset

function startResizeKey(key) {
  if (activeKeyResize) {
    if (activeKeyResize.key === key) return // OS key-repeat while already held — ignore
    activeKeyResize.handle.commit() // switching key mid-hold: commit the other one first
    activeKeyResize = null
  }
  const b = focusedBlock()
  if (!b) return
  const widthKey = 'diff:' + b.id
  const root = document.querySelector('[data-diff-col-key="' + widthKey + '"]')
  if (!root) return
  const handle = startKeyResize(state, widthKey, root, key === 'c' ? -1 : 1)
  activeKeyResize = { key, widthKey, pressStart: performance.now(), handle }
}

// stopResizeKey — the keyup counterpart. Decides whether this release closes
// a genuine hold (commit the width it landed on) or is the SECOND half of a
// quick double-tap (reset to auto instead, discarding whatever tiny width
// change the brief tap itself made — mirroring the resize handle's own
// dblclick reset, which likewise ignores any drag distance).
function stopResizeKey(key) {
  if (!activeKeyResize || activeKeyResize.key !== key) return
  const { widthKey, pressStart, handle } = activeKeyResize
  activeKeyResize = null
  const now = performance.now()
  const heldMs = now - pressStart
  const isShortTap = heldMs <= KEY_RESIZE_TAP_MAX_MS
  // Double-tap-to-reset is deliberately `c`-only — reviewer report: growing a
  // column by tapping `v` twice in quick succession (meaning "grow it some
  // more") kept getting misread as the double-tap reset instead, wiping out
  // both taps' width change. `c` (shrink) keeps the double-tap reset
  // unchanged; a `v` release always just commits, like a genuine hold would.
  const isDoubleTap =
    key === 'c' && isShortTap && lastTap[key].short && now - lastTap[key].time <= KEY_RESIZE_DOUBLE_TAP_MS
  lastTap[key] = { time: now, short: isShortTap }
  if (isDoubleTap) {
    handle.cancel()
    clearColumnWidth(state, widthKey)
  } else {
    handle.commit()
  }
}

// focusedGranCursor resolves the {gran, change} of whichever column currently
// owns the keyboard — the top-level state.gran/state.change (focusLevel 0), or
// the focused drilled column's own state.drillCursor[level-1] entry
// (focusLevel > 0). Mirrors callArrowPairs' inline `cur` resolution and
// approveContext's level-branch; callScopeMethods/groupLineRange/
// relatedChildren/resolvedCallChildren use it so the Onderliggende-code panel
// scopes/reorders on whichever column is actually focused, not always the
// top-level block (see .claude/docs/detail-layout.md, "Kolom-navigatie").
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
    const units = navUnitsOf(b, blockRows(b), 'group')
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
  const units = navUnitsOf(b, blockRows(b), cur.gran)
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
  const curUnit = navUnitsOf(b, rows, cur.gran)[cur.change]
  const anchorRow = curUnit ? curUnit.start : 0
  let to = Math.min(GRANS.length - 1, Math.max(0, from + delta))
  // Same single-row-group shortcut as setGran: skip 'line' straight to 'call'.
  if (delta > 0 && cur.gran === 'group' && curUnit && curUnit.end === curUnit.start) {
    to = GRANS.indexOf('call')
  }
  if (to === from) return
  const gran = GRANS[to]
  const units = navUnitsOf(b, rows, gran)
  const change = units.length ? unitAtRow(units, anchorRow) : 0
  state.drillCursor = state.drillCursor.map((c, i) => (i === level - 1 ? { gran, change } : c))
  scrollChangeIntoView()
}

// drillExtendRange mirrors extendRange, but for the drilled column at `level`
// (its own drillCursor entry instead of state.gran/state.change/
// state.rangeAnchor). Only meaningful at gran==='line' or gran==='group' (see
// isRangeGran); clamps at the column's own first/last unit — a range never
// flows sideways into a sibling (drillNextChange/drillPrevChange's sibling
// walk), since approve/comment act on rows of a single block.
function drillExtendRange(level, delta) {
  const b = state.drill[level - 1]
  const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  if (!b || !isRangeGran(cur.gran)) return
  const units = navUnitsOf(b, blockRows(b), cur.gran)
  if (!units.length) return
  const anchor = cur.rangeAnchor != null ? cur.rangeAnchor : cur.change
  const change = Math.min(units.length - 1, Math.max(0, cur.change + delta))
  state.drillCursor = state.drillCursor.map((c, i) => (i === level - 1 ? { ...c, change, rangeAnchor: anchor } : c))
  scrollChangeIntoView()
}

// ── Mouse line selection: native browser text selection, resolved on mouseup ──
// Wired via Block()'s onRowMouseDown opt (home.mjs's own Block(...) call sites
// below), fired from the delegated onBlockMouseDown in Block.mjs. Reviewer
// request: "ik wil dat huidige manier van selecteren in de diff met mijn muis
// weg gaat [...] ik wil de browser selectie manier gebruiken" — a mousedown on
// a row no longer resolves anything itself; it only SEEDS which row/call-
// segment/card the gesture started on (beginMouseSelection, below), and the
// browser's own text selection is left completely alone (Block.mjs no longer
// calls preventDefault() for it). The gesture is resolved exactly ONCE, on the
// next `mouseup`, by reading `window.getSelection()`:
//
// - **Shift+click is checked FIRST, before ever reading the native
//   selection** → resolveShiftClickSelection: extends the app's OWN
//   rangeAnchor/change (or the drilled column's own drillCursor entry) to the
//   clicked row, exactly like the old keyboard-driven extendRowRange did.
//   Deliberately NOT resolved via the browser's native selection-extend
//   behaviour — every diff pane is one big `.innerHTML` string, reassigned
//   WHOLESALE on every `state.change`/`gran` write, so the state mutation a
//   PRECEDING plain click just made destroys every row's DOM node, including
//   whichever one held the browser's native caret; a following Shift+click
//   then has no valid anchor left to extend from (observed: Chrome doesn't
//   cleanly collapse the selection in that case, it silently reassigns the
//   anchor to the first node of the new container — silently WRONG, not
//   merely absent). See resolveShiftClickSelection's own comment.
// - No selection at all, or a COLLAPSED one (a plain click with no drag) →
//   resolveClickSelection: a call-segment first, else the exact line/
//   reference unit the click landed on, else — reviewer confirmed — NO
//   interaction at all ("als er geen line is aangepast, dan wil ik daar geen
//   interactie van zien").
// - A real, non-collapsed selection whose two ends both resolve to a
//   `[data-row]` inside the SAME card the gesture started on →
//   resolveRangeSelection: rounds up to every touched LINE (never per group,
//   never per call — reviewer: "afronden op hele regels"), reusing the exact
//   nearest-fallback `unitAtRow` lookup a gran switch already uses. This is
//   also what makes a native double/triple-click (word/paragraph select,
//   confined to one row's own <div>, and self-contained — it never depends
//   on a PRIOR selection the way Shift+click would) fall out of this SAME
//   mechanism for free. That rounding is for `state.rangeAnchor`/`change`
//   ONLY — resolveRangeSelection's own `state` write destroys the row DOM the
//   real selection pointed into (the same wholesale-`.innerHTML` mechanism
//   Shift+click has to work around above), so `resolvePendingMouseSelection`
//   snapshots the EXACT original selection first (captureSelectionSnapshot)
//   and resolveRangeSelection re-applies it, character-for-character, once
//   the new DOM exists (restoreExactSelection) — reviewer: "ik wil alles
//   kunnen selecteren als normaal [...] en kopiëren", so what stays visibly
//   selected/copyable must NOT be rounded up the way the navigation unit is.
//
// See "Line selection: click and browser text selection" in
// .claude/docs/diff-render.md.

// ensureTopLevelDiffFocus brings the keyboard fully onto the top-level diff of
// block index `i` — reviewer request: "een klik op een andere kaart dan de
// focus kaart moet dat kaart focussen alsof je gewoon met je key er
// navigeert". Reuses the exact functions the corresponding key sequence would
// call, never a parallel implementation (mouse-navigation.md, Rule 1):
// expandColumn(0)/leaveRelated() mirror repeated ← out of a drilled column or
// the comments/Onderliggende-code panel, stepBlock mirrors ↓ flowing across a
// same-file boundary, and the ← (list) → (enterDiff) fallback mirrors the
// general path for a different-file neighbour (there is no same-file flow to
// reuse there). Called from resolveClickSelection/resolveRangeSelection
// below; the caller's own unit lookup then overrides whatever landing unit
// stepBlock/enterDiff picked, so the reviewer always ends up exactly on the
// row they clicked/selected.
function ensureTopLevelDiffFocus(i) {
  if (state.focusLevel > 0) expandColumn(0)
  else if (relatedActive()) leaveRelated()
  if (i === state.selected) {
    if (state.mode !== 'diff') enterDiff()
    else {
      // A click straight into the code releases the description strip, exactly
      // like ↓ off it does (see clearBlockDescFocus).
      clearBlockDescFocus()
      clearRangeAnchor(0)
    }
    scheduleDiffColumnFit()
    return
  }
  // stepBlock's same-file flow is only ever a thing WITHIN diff mode (it's
  // what ↓/f run off the last unit already invoke) — there is no "flow"
  // concept from list mode, so only try it once we're actually in diff mode.
  if (state.mode === 'diff' && stepBlock(i - state.selected)) {
    scheduleDiffColumnFit()
    return
  }
  // Either a different file's neighbour, or the reviewer hadn't stepped into
  // diff mode yet at all — the real keyboard path is ← back to the list
  // (already there in the latter case), ↓/click to select the row, then →.
  state.selected = i
  clearListAnchor()
  clearRangeAnchor(0)
  enterDiff()
  // A click is not a nav-chain step: keep whichever left column still fits
  // (see applyDiffColumnFit). Called here, at the one function every MOUSE
  // path into a top-level diff funnels through, so the keyboard's own
  // enterDiff callers keep their unchanged "stepping right hides it" behaviour.
  scheduleDiffColumnFit()
}

// pendingMouseSelection is the plain (non-reactive) module-level record a
// mousedown seeds — never touches `state` itself, since a mousedown doesn't
// yet know whether the gesture will end up a plain click or a real drag/
// native selection. Cleared by resolvePendingMouseSelection on the very next
// mouseup, so it never survives past the gesture that set it.
let pendingMouseSelection = null

// beginMouseSelection is Block()'s onRowMouseDown callback (see the two
// DetailPanel call sites below): `level`/`b`/`i` are exactly the plumbing
// resolveClickSelection/resolveRangeSelection need (0 = top-level diff, >0 =
// a drilled column's own focus level; `i` only meaningful at level 0).
// `segStart` is null from a drilled column's own closure, which keeps a
// drilled column's click 'call'-free, same as before. `cardEl` is the
// mousedown's own `e.currentTarget` (Block.mjs) — the card the gesture
// started on, used by rowOfNode below to scope a resolved selection to it.
// `shiftKey` is only ever read as resolveShiftClickSelection's own trigger (see
// the file-level comment above).
function beginMouseSelection(level, b, i, row, segStart, cardEl, shiftKey) {
  pendingMouseSelection = { level, b, i, row, segStart, cardEl, shiftKey }
}

// closestRowEl walks a Selection endpoint (a DOM Node — often a Text node) up
// to its nearest `[data-row]` ancestor element, but ONLY when that element
// actually sits inside `cardEl` — the card the gesture's own mousedown
// started on. A selection that spilled into a different card (or outside any
// diff row entirely, e.g. into a comment/description column) must never be
// resolved against THIS card's units, so this returns null rather than
// guessing. Shared by rowOfNode (below) and captureSelectionSnapshot.
function closestRowEl(node, cardEl) {
  if (!node || !cardEl) return null
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  const rowEl = el && el.closest && el.closest('[data-row]')
  if (!rowEl || !cardEl.contains(rowEl)) return null
  return rowEl
}

// rowOfNode resolves a Selection endpoint to its row's numeric `data-row`
// index — see closestRowEl for the actual walk/scoping.
function rowOfNode(node, cardEl) {
  const rowEl = closestRowEl(node, cardEl)
  if (!rowEl) return null
  const row = +rowEl.getAttribute('data-row')
  return Number.isNaN(row) ? null : row
}

// rowRelativeOffset measures how many characters of `rowEl`'s own rendered
// text sit before the boundary point (node, offset) — i.e. the position a
// browser Selection boundary inside that row corresponds to, counted from the
// row's own start. Used to survive the row's DOM nodes being replaced
// wholesale (see restoreExactSelection's own doc comment): the character
// count itself is stable across a re-render (same text, same checkmarks/
// badges) even though the exact Text node objects are not. Implemented via a
// throwaway Range + `toString()` rather than a hand-rolled TreeWalker sum —
// the browser already does the visual-order text concatenation correctly
// (this is the standard trick for "text offset within a container").
function rowRelativeOffset(rowEl, node, offset) {
  const r = document.createRange()
  r.selectNodeContents(rowEl)
  r.setEnd(node, offset)
  return r.toString().length
}

// locateOffsetInRow is rowRelativeOffset's inverse: given a row element and a
// character count (from a snapshot taken before that row's own DOM was torn
// down and rebuilt), finds the (Text node, local offset) pair at that
// position in the CURRENT row. Walks the row's own text nodes in document
// order — the same order `rowRelativeOffset`'s Range-based count implies —
// summing lengths until the target position falls inside one of them.
// Clamps to the end of the last text node when `charOffset` reaches or
// exceeds the row's total length (e.g. a selection boundary that sat exactly
// at the row's own end). Returns null for a row with no text at all (should
// not happen for a real code row, but guarded rather than assumed).
function locateOffsetInRow(rowEl, charOffset) {
  const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT)
  let remaining = charOffset
  let lastNode = null
  let node
  while ((node = walker.nextNode())) {
    lastNode = node
    const len = node.textContent.length
    if (remaining <= len) return { node, offset: remaining }
    remaining -= len
  }
  return lastNode ? { node: lastNode, offset: lastNode.textContent.length } : null
}

// captureSelectionSnapshot records a native Selection's anchor/focus as
// {row, row-relative character offset} pairs — everything restoreExactSelection
// needs to reconstruct the EXACT same selection (same start/end point, same
// direction) after the row DOM it pointed into gets replaced wholesale. See
// restoreExactSelection's own doc comment for why this exists at all. Returns
// null when either endpoint doesn't resolve to a row inside `cardEl` (mirrors
// rowOfNode's own "don't guess" contract) — the caller then simply skips the
// restore.
function captureSelectionSnapshot(sel, cardEl) {
  const anchorRowEl = closestRowEl(sel.anchorNode, cardEl)
  const focusRowEl = closestRowEl(sel.focusNode, cardEl)
  if (!anchorRowEl || !focusRowEl) return null
  return {
    anchorRow: +anchorRowEl.getAttribute('data-row'),
    anchorOffset: rowRelativeOffset(anchorRowEl, sel.anchorNode, sel.anchorOffset),
    focusRow: +focusRowEl.getAttribute('data-row'),
    focusOffset: rowRelativeOffset(focusRowEl, sel.focusNode, sel.focusOffset),
  }
}

// restoreExactSelection re-applies a native Selection snapshot (see
// captureSelectionSnapshot) once the row DOM it pointed into has been
// rebuilt — reviewer report: "ik kan niet normaal met een muis een selectie
// doen ... want na een fractie van een seconde is het niet meer geselecteerd
// (in de diff)". Root cause: every diff pane reassigns its entire
// `.innerHTML` on the very `state.gran`/`change`/`rangeAnchor` write
// resolveRangeSelection makes right after a real drag/native selection (see
// resolvePendingMouseSelection's own comment) — that wholesale replacement
// destroys the row's old DOM nodes, so the browser's own native selection
// (which the reviewer explicitly wants to keep using for reading/copying —
// "het doel van de feature was juist dat je gewoon met de muis kunt
// selecteren (en kopiëren)") collapses to nothing within the same tick.
//
// Deliberately restores the EXACT original start/end (same characters, same
// direction), never rounded up to the whole line the way the app's own
// `state.rangeAnchor`/`change` are (confirmed: rounding the visible/copyable
// selection itself would silently corrupt a "select half a word to copy it"
// gesture) — `Selection.setBaseAndExtent` (not a plain Range) is what
// preserves the true anchor→focus direction the reviewer dragged in, not
// just its start/end order.
//
// Deferred one `requestAnimationFrame` — the same "wait one frame for the
// just-swapped state to actually render" pattern `showPassiveMenu` used to
// rely on (removed, see "The right-click context menu" in
// command-palette.md) — so the row elements being queried here are the NEW
// (already re-rendered) ones. `cardEl.isConnected` guards
// against the reviewer having navigated away before that frame fires (the
// card itself unmounted, e.g. `document.body.contains` is false already).
function restoreExactSelection(cardEl, snapshot) {
  if (!snapshot) return
  requestAnimationFrame(() => {
    if (!cardEl || !cardEl.isConnected) return
    const anchorRowEl = cardEl.querySelector('[data-row="' + snapshot.anchorRow + '"]')
    const focusRowEl = cardEl.querySelector('[data-row="' + snapshot.focusRow + '"]')
    if (!anchorRowEl || !focusRowEl) return
    const anchorPos = locateOffsetInRow(anchorRowEl, snapshot.anchorOffset)
    const focusPos = locateOffsetInRow(focusRowEl, snapshot.focusOffset)
    if (!anchorPos || !focusPos) return
    const sel = window.getSelection()
    if (!sel) return
    sel.setBaseAndExtent(anchorPos.node, anchorPos.offset, focusPos.node, focusPos.offset)
  })
}

// resolvePendingMouseSelection is called from the document's own `mouseup`
// listener, exactly once per gesture. See the file-level comment above for the
// click-vs-range decision. Shift+click is checked FIRST, before ever reading
// `window.getSelection()` — it is resolved via app state alone
// (resolveShiftClickSelection), never via the browser's own native
// selection-extend behaviour. That is a deliberate departure from "just read
// whatever the browser selected", forced by this app's own rendering: a
// diff pane is one big `.innerHTML` string, reassigned WHOLESALE on every
// `state.change`/`gran` write (see "`blockRows(b)` is memoized" in
// diff-render.md) — so the very state mutation a PRECEDING plain click just
// made destroys every row's DOM node, including whichever one the browser's
// native caret pointed at. A subsequent Shift+click then has no valid native
// anchor to extend from any more; observed in testing, Chrome doesn't cleanly
// collapse the selection in that case, it silently reassigns the anchor to
// the first node of the (new) container instead — silently wrong, not merely
// absent. A genuine drag (one continuous mousedown→mouseup, no state
// mutation in between) and a native double-/triple-click (self-contained,
// never depends on a PRIOR selection) don't have this problem, so they still
// read `window.getSelection()` directly, below.
function resolvePendingMouseSelection() {
  const pending = pendingMouseSelection
  pendingMouseSelection = null
  if (!pending) return
  if (pending.shiftKey) {
    if (!resolveShiftClickSelection(pending)) resolveClickSelection(pending)
    return
  }
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) {
    const startRow = rowOfNode(sel.anchorNode, pending.cardEl)
    const endRow = rowOfNode(sel.focusNode, pending.cardEl)
    if (startRow != null && endRow != null) {
      // Snapshot the real selection BEFORE resolveRangeSelection's own state
      // write tears down the row DOM it points into — see
      // restoreExactSelection's own doc comment.
      const snapshot = captureSelectionSnapshot(sel, pending.cardEl)
      resolveRangeSelection(pending, startRow, endRow, snapshot)
      return
    }
  }
  resolveClickSelection(pending)
}

// resolveShiftClickSelection extends the app's OWN keyboard/mouse-set cursor
// (state.rangeAnchor/state.change, or the drilled column's own drillCursor
// entry) to the clicked row — deliberately never via the browser's native
// selection-extend behaviour (see resolvePendingMouseSelection's own comment
// for why that's unreliable here). Mirrors the old extendRowRange's own
// row-index logic verbatim, just resolved once here instead of continuously
// on every mousemove of a drag. Never for a TRANSLATION block, same
// exclusion as resolveRangeSelection. Returns whether it actually extended
// something, so a Shift+click landing on a card that doesn't already own the
// keyboard falls through to the ordinary "select this row" path
// (resolveClickSelection) instead — there is no earlier selection on that
// card to extend from. No longer calls a passive-menu-preview scheduler
// (removed — see "The right-click context menu" in command-palette.md); an
// ordinary click/selection now shows no menu at all, only a right-click does.
function resolveShiftClickSelection({ level, b, row }) {
  if (b && b.category === 'TRANSLATION') return false
  const rows = blockRows(b)
  if (level === 0) {
    if (state.mode !== 'diff' || !isActiveCard(b) || state.focusLevel !== 0) return false
    state.gran = 'line'
    const units = navUnitsOf(b, rows, 'line')
    if (!units.length) return false
    const target = unitAtRow(units, row)
    const anchor = state.rangeAnchor != null ? state.rangeAnchor : state.change
    state.rangeAnchor = anchor
    state.change = target
    return true
  }
  if (state.focusLevel !== level) return false
  const cur = state.drillCursor[level - 1]
  if (!cur) return false
  const units = navUnitsOf(b, rows, 'line')
  if (!units.length) return false
  const target = unitAtRow(units, row)
  const anchor = cur.gran === 'line' && cur.rangeAnchor != null ? cur.rangeAnchor : cur.change
  state.drillCursor = state.drillCursor.map((c, idx) =>
    idx === level - 1 ? { ...c, gran: 'line', change: target, rangeAnchor: anchor } : c,
  )
  return true
}

// resolveClickSelection implements a genuine click (no drag, no native
// double/triple-click, no Shift+click extend — those all produce a real
// selection and go through resolveRangeSelection instead). Reviewer answer:
// "call selecteren, als er geen call geselecteerd kan worden, dan de line
// selecteren. als er geen line is aangepast, dan wil ik daar geen interactie
// van zien" — so a click that lands on neither a real call-segment nor an
// exact line/reference unit does ABSOLUTELY NOTHING: no focus steal, no
// scroll, no state change at all (unlike the old click-count scheme, which
// snapped to the NEAREST unit regardless of exactly where the click landed).
// `level`/`i` mirror ensureTopLevelDiffFocus's own plumbing (0 = top-level
// diff, >0 = a drilled column's own focus level; `i` only meaningful at
// level 0). TRANSLATION blocks are excluded from the call-segment branch
// (their gran stays pinned at 'group' — see navUnitsOf/setGran's own
// exclusion): every click there keeps landing on the one key-row under it,
// same as before.
//
// Returns whether it actually landed on a real navigation unit — true for
// every branch that mutates state.gran/change (or a drilled column's own
// drillCursor entry), false for the "no landable unit here" and early-exit
// branches. An ordinary click (resolvePendingMouseSelection) ignores this;
// handleRowContextMenu (the right-click path, below) reads it to decide
// whether to suppress the native browser menu — see "The right-click context
// menu" in command-palette.md.
function resolveClickSelection({ level, b, i, row, segStart }) {
  const isTranslation = !!(b && b.category === 'TRANSLATION')
  const rows = blockRows(b)
  if (level === 0) {
    if (!isTranslation && segStart != null) {
      const callUnits = navUnitsOf(b, rows, 'call')
      const idx = callUnits.findIndex((u) => u.start === row && u.segStart === segStart)
      if (idx >= 0) {
        ensureTopLevelDiffFocus(i)
        if (state.mode !== 'diff' || !isActiveCard(b)) return false
        state.gran = 'call'
        clearRangeAnchor(0)
        state.change = idx
        return true
      }
      // Defensive only (the segment came straight from the same
      // rowCallSegments/changeCalls split, so this shouldn't happen) — fall
      // through to the ordinary line click below.
    }
    const lineUnits = navUnitsOf(b, rows, 'line')
    const idx = lineUnits.findIndex((u) => u.start <= row && row <= u.end)
    if (idx < 0) return false // no changed/landable line here — no interaction at all
    ensureTopLevelDiffFocus(i)
    if (state.mode !== 'diff' || !isActiveCard(b)) return false
    if (!isTranslation) state.gran = 'line'
    clearRangeAnchor(0)
    state.change = idx
    return true
  }
  if (state.focusLevel !== level) return false
  const cur = state.drillCursor[level - 1]
  if (!cur) return false
  const gran = isTranslation ? cur.gran : 'line'
  const units = navUnitsOf(b, rows, gran)
  const idx = units.findIndex((u) => u.start <= row && row <= u.end)
  if (idx < 0) return false // same "no landable unit here → no interaction" rule
  if (relatedActive()) leaveRelated()
  state.drillCursor = state.drillCursor.map((c, idx2) => (idx2 === level - 1 ? { ...c, gran, change: idx, rangeAnchor: null } : c))
  return true
}

// handleRowContextMenu is the right-click counterpart of beginMouseSelection/
// resolvePendingMouseSelection above (see Block.mjs's onRowContextMenu opt,
// wired at both DetailPanel Block() call sites next to onRowMouseDown). A
// right-click has no drag/native-selection gesture to protect (unlike a
// mousedown, per the file-level comment above), so this resolves SYNCHRONOUSLY
// via resolveClickSelection — the exact same landing logic an ordinary click
// uses — and only opens the (native-styled, cursor-positioned) block palette
// when that actually landed on a real unit; otherwise it returns false and
// Block.mjs's onBlockContextMenu leaves the native browser menu in place
// (Copy/Look up on an unchanged/filler line). Mode is always 'block': a
// right-click on a diff row only ever happens while a block is focused, never
// at stop 1. See "The right-click context menu" in command-palette.md.
function handleRowContextMenu(level, b, i, row, segStart, x, y) {
  // A right-click INSIDE the current selection leaves it exactly as it is —
  // reviewer report: "als ik iets selecteer en dan rechtermuisknop druk, gaat
  // de selectie weg. dat wil ik niet". resolveClickSelection would collapse a
  // Shift+arrow / drag range back onto the single clicked line (and re-force
  // gran to 'line'), which is the opposite of what a context menu on a
  // selection should do — the menu's actions are ABOUT that selection.
  // Clicking a row outside it still lands there first, unchanged, matching
  // every other platform's right-click behaviour.
  //
  // Skipping the `state` write also keeps the reviewer's NATIVE text
  // selection alive for free: it is the row-DOM teardown that write triggers
  // which otherwise wipes it (see restoreExactSelection's own doc comment).
  if (!rowInsideActiveSelection(level, b, row)) {
    if (!resolveClickSelection({ level, b, i, row, segStart })) return false
  }
  openMenu('block', { native: true, x, y })
  return true
}

// rowInsideActiveSelection reports whether `row` already falls within the unit
// the given level's cursor covers — a single group/line/call unit, or the
// merged span of an active Shift+arrow/drag range (rangeUnit). Returns false
// whenever that level doesn't currently own the keyboard, or the card isn't
// the active one (a look-ahead preview), so a right-click there still lands
// normally.
function rowInsideActiveSelection(level, b, row) {
  const rows = blockRows(b)
  if (!rows.length) return false
  let gran
  let change
  let anchor
  if (level === 0) {
    if (state.mode !== 'diff' || !isActiveCard(b)) return false
    gran = state.gran
    change = state.change
    anchor = state.rangeAnchor
  } else {
    if (state.focusLevel !== level) return false
    const cur = state.drillCursor[level - 1]
    if (!cur) return false
    gran = cur.gran
    change = cur.change
    anchor = cur.rangeAnchor
  }
  const units = navUnitsOf(b, rows, gran)
  const u = rangeUnit(units, change, isRangeGran(gran) ? anchor : null)
  return !!u && row >= u.start && row <= u.end
}

// resolveRangeSelection implements a real, non-collapsed selection — a mouse
// drag, a native double/triple-click (word/paragraph select, always confined
// to one row's own <div>, so startRow === endRow there), or the browser's own
// Shift+click extend (which reuses its existing selection anchor) — all of
// which land here identically, since all three simply produce a genuine
// Selection spanning from `startRow` to `endRow`. Reviewer answer: "afronden
// op hele regels: elke aangeraakte regel wordt meegenomen" — gran is
// unconditionally forced to 'line' (never 'group'/'call'), and unlike
// resolveClickSelection there is no "unchanged line → no interaction"
// exception here: a genuine text selection always resolves to SOME line
// range, snapping each end to the nearest real unit exactly like a gran
// switch already does (unitAtRow). Never for a TRANSLATION block — the same
// exclusion setGran/extendRange already apply — so a text selection there
// simply falls back to a plain click on its start row.
//
// `snapshot` (captureSelectionSnapshot, or null) is the ORIGINAL native
// selection the reviewer actually made, captured before this function's own
// `state` write below tears down the row DOM it points into.
// restoreExactSelection re-applies it, EXACT character-for-character — never
// rounded to the `lo`/`hi` line range `state.rangeAnchor`/`change` use — once
// the new DOM has rendered: the app's own navigation unit is deliberately
// whole-line, but what the reviewer can still read/copy with the mouse must
// stay exactly what they dragged (reviewer: "ik wil alles kunnen selecteren
// als normaal"; see restoreExactSelection's own doc comment for the full
// reasoning). Skipped on every early return below (no `state` write there,
// so nothing to restore against).
function resolveRangeSelection(pending, startRow, endRow, snapshot) {
  const { level, b, i, cardEl } = pending
  if (b && b.category === 'TRANSLATION') {
    resolveClickSelection({ ...pending, row: startRow, segStart: null })
    return
  }
  const rows = blockRows(b)
  const lo = Math.min(startRow, endRow)
  const hi = Math.max(startRow, endRow)
  if (level === 0) {
    ensureTopLevelDiffFocus(i)
    if (state.mode !== 'diff' || !isActiveCard(b)) return
    state.gran = 'line'
    const units = navUnitsOf(b, rows, 'line')
    if (!units.length) return
    state.rangeAnchor = unitAtRow(units, lo)
    state.change = unitAtRow(units, hi)
    restoreExactSelection(cardEl, snapshot)
    return
  }
  if (state.focusLevel !== level) return
  const cur = state.drillCursor[level - 1]
  if (!cur) return
  const units = navUnitsOf(b, rows, 'line')
  if (!units.length) return
  if (relatedActive()) leaveRelated()
  const startIdx = unitAtRow(units, lo)
  const endIdx = unitAtRow(units, hi)
  state.drillCursor = state.drillCursor.map((c, idx) =>
    idx === level - 1 ? { ...c, gran: 'line', change: endIdx, rangeAnchor: startIdx } : c,
  )
  restoreExactSelection(cardEl, snapshot)
}

// approveClickAt resolves a click on one of Block.mjs's call-segment approve
// markers (a dot or a hover-only ring — see onApproveClick/onBlockMouseDown)
// to a navigation unit and positions the keyboard there, mirroring
// resolveClickSelection's own level/i plumbing verbatim (0 = the top-level
// diff, >0 = a drilled column's own focus level; `i` only matters at level 0, see
// ensureTopLevelDiffFocus) — a click always forces 'call' granularity, the
// same "override whatever gran the keyboard had active" rule the plain row
// click already applies (see "Line selection" in diff-render.md). Once
// positioned it runs mouseApprove() below — the mouse counterpart of Space —
// so approving (or retracting) and continuing happen in the same click. The
// `kind` parameter is a holdover from the wider line/group/call gutter
// affordance this used to also serve (see approval.md's "Approving from the
// mouse" — the line/group toggles were removed); only `'call'` is ever
// dispatched now (Block.mjs's onBlockMouseDown only routes `[data-seg-dot]`),
// left in place rather than pruned since it's still exactly the right shape.
function approveClickAt(level, b, i, row, kind, segStart) {
  const gran = kind === 'group' ? 'group' : kind === 'call' ? 'call' : 'line'
  const rows = blockRows(b)
  if (level === 0) {
    ensureTopLevelDiffFocus(i)
    if (state.mode !== 'diff' || !isActiveCard(b)) return
    const units = navUnitsOf(b, rows, gran)
    if (!units.length) return
    let change
    if (gran === 'call') {
      change = units.findIndex((u) => u.start === row && u.segStart === segStart)
      if (change < 0) return
    } else {
      change = unitAtRow(units, row)
    }
    clearRangeAnchor(0)
    state.gran = gran
    state.change = change
    mouseApprove()
    return
  }
  if (state.focusLevel !== level) return
  if (relatedActive()) leaveRelated()
  const cur = state.drillCursor[level - 1]
  if (!cur) return
  const units = navUnitsOf(b, rows, gran)
  if (!units.length) return
  let change
  if (gran === 'call') {
    change = units.findIndex((u) => u.start === row && u.segStart === segStart)
    if (change < 0) return
  } else {
    change = unitAtRow(units, row)
  }
  state.drillCursor = state.drillCursor.map((c, idx) => (idx === level - 1 ? { ...c, gran, change, rangeAnchor: null } : c))
  mouseApprove()
}

// mouseApprove is the mouse counterpart of Space's approve step (see
// spaceKey/"Space" in keyboard-navigation.md, further below): it reuses the
// exact same approveContext()/descendIntoUnapprovedCall/toggleApprove(true)
// chain, so approving + continuing to the next unapproved unit happen in one
// click, same as one Space press — no second approve/continue
// implementation. Deliberately differs from spaceKey in exactly one place,
// per explicit reviewer answer: clicking an ALREADY approved marker RETRACTS
// it (toggleApprove(true) already flips either direction depending on
// whether the target is fully approved) instead of Space's own "already done
// → only continue" behaviour (isApproveDone's branch in spaceKey never
// toggles) — a reviewer clicking directly on a ✓/filled square/solid dot is
// asking to undo it, not to skip past it. A retract intentionally does NOT
// continue either (toggleApprove/afterApproveAction's `if (!approving)
// return` — a retract never auto-advances anywhere else in this app, and
// this mouse action is not an exception).
//
// Unlike Space — which deliberately shows no menu at all (see spaceKey's own
// comment) — this used to also show the mouse-selection passive
// command-palette preview once the approve+continue chain settled. That
// preview mechanism no longer exists at all (see "The right-click context
// menu" in command-palette.md — right-click replaced it everywhere, and a
// call-approve dot has no obvious "cursor position" of its own to right-click
// on after an auto-continue jumps elsewhere), so a click on a call-approve
// dot now behaves exactly like Space: approve (or retract) + auto-continue,
// no menu shown.
function mouseApprove() {
  const ctx = approveContext()
  if (!ctx.b) return
  if (isApproveDone(ctx)) {
    toggleApprove(true)
    return
  }
  descendIntoUnapprovedCall(ctx).then((handled) => {
    if (!handled) toggleApprove(true)
  })
}

// focusDrillPreviewSibling brings a click on the drilled column's own
// look-ahead preview card (drillPreviewColumns, always rendered nested inside
// the ALREADY-focused column — see its own doc comment) onto that sibling:
// the mouse equivalent of ↓/f run off the end of the focused column's own
// units, which sideways-flows into the next sibling (drillNextChange/
// drillToSibling). Reuses drillToSibling directly rather than reimplementing
// the sideways swap.
function focusDrillPreviewSibling() {
  if (relatedActive()) leaveRelated()
  const ctx = drillSiblingContext()
  const next = ctx && ctx.siblings[ctx.idx + 1]
  if (next) drillToSibling(next, false)
}

// focusedColumnEl resolves the actual on-screen column that currently owns
// the keyboard at a given focusLevel: the top-level block-column at level 0,
// or the drilled column at that level (`drill-column`'s own 1-based index)
// otherwise. Shared by scrollFocusIntoView below and menuAnchor/menuRegion's
// 'prComment'/'replyPublish' fallback (see the comment there for why the bare
// `[data-testid="block-column"]` selector alone is wrong once a comment's own
// anchor block is drilled open, openCommentAnchorDrill: that column collapses
// to a narrow rail — still carrying the same testid — while a deeper
// drill-column holds the real, focused content).
function focusedColumnEl(level = state.focusLevel) {
  return level === 0
    ? document.querySelector('[data-testid="block-column"]')
    : document.querySelectorAll('[data-testid="drill-column"]')[level - 1]
}

// scrollFocusIntoView scrolls whichever column now owns the diff keyboard into
// view — <main> scrolls horizontally, so stepping across drilled columns (or
// back to the original block) could otherwise land off-screen. Deferred a
// frame so a freshly-pushed drill column exists in the DOM first.
function scrollFocusIntoView(level = state.focusLevel) {
  requestAnimationFrame(() => {
    // Stop 2b (the methodes-kolom, see .claude/docs/test-class-grouping.md) is
    // the block-column's LEFT neighbour whenever it exists, so aligning on the
    // block-column would scroll it out of view — which is exactly what
    // happened on a restored `?sel=testclass:…` link: the relatedActive/
    // codeVersion watch below calls this on every code load, leaving <main>
    // scrolled one column width right with stop 2b hidden behind the pr-index
    // (reported bug: "I see 52/116 in the index but nothing else to approve in
    // the diff, and I can't navigate into it"). Targeting it instead puts
    // <main> back at its real rest position (both columns visible) and also
    // brings the column into view when `→` focuses it while <main> is
    // scrolled. A plain DOM query is enough: this column only renders in list
    // mode on a selected test_class row (see DetailPanel), and it can never
    // exist for a drilled level (level > 0).
    const el =
      (level === 0 && document.querySelector('[data-testid="test-methods-column"]')) || focusedColumnEl(level)
    // Always align to the *left* edge of the viewport: the top-level block
    // column is the leftmost column, and a freshly-focused drilled column
    // should land flush against <main>'s left edge too (rather than its right
    // edge) so the columns it was drilled from stay hinted-at via the
    // left-edge chevron below instead of scrolling fully out of reach.
    if (el) el.scrollIntoView({ inline: 'start', block: 'nearest' })
  })
}

// scrollRelatedIntoView is scrollFocusIntoView's mirror for the comment/
// composer/Claude-chat/Onderliggende-code column to the RIGHT of the diff
// (comment-claude-row + related-code, see .claude/docs/detail-layout.md's
// "The embedded Claude chat column"): reviewer request — a wide split-diff
// block leaves the composer's send button and/or the whole Claude column
// clipped off the right edge of the viewport once the reviewer steps the
// keyboard/mouse into that panel (relatedActive() true). Deferred a frame
// like every other scroll helper here, so a freshly mounted target (e.g. the
// composer opening for the first time) exists in the DOM first. Also called
// from setupMainOverflowObserver below whenever <main>'s real content width
// changes while the panel is already active — a fresh page load restoring
// ?rel.foc=… from the URL can own the keyboard before the diff/code it sits
// next to has actually finished rendering, so the overflow this scroll reacts
// to only appears once that later render lands, after the one-time
// relatedActive() transition already fired.
function scrollRelatedIntoView(tries = 10) {
  requestAnimationFrame(() => {
    // The transition into relatedActive() can fire before the panel's own
    // content has actually mounted (e.g. a fresh page load restoring
    // ?rel.foc=new/comment/thread/claude/code from the URL, still awaiting
    // the block's code/comments to load) — retry a few frames, the same
    // pattern scrollChangeIntoView above uses for its own lazily-rendered
    // anchor. Bail if the reviewer has already left the panel again by the
    // time a retry runs.
    if (!relatedActive()) return
    // Onderliggende code ('code') is its own row below comment-claude-row —
    // target it directly. Every other focus ('new'/'comment'/'thread'/
    // 'claude') targets the WHOLE merged comment+Claude card
    // (comment-claude-row), not just the comment or Claude half on its own:
    // the two columns sit side by side in one card (see "One merged card, not
    // two" in .claude/docs/detail-layout.md), and while composing a brand-new
    // comment (cs.focus === 'new') the Claude column already shows
    // optimistically right next to the composer — exactly the reported case
    // (screenshot: the composer's own send button fit, but the Claude column
    // beside it stayed clipped off the right edge).
    const el = isCodeFocused()
      ? document.querySelector('[data-testid="related-code"]')
      : document.querySelector('[data-testid="comment-claude-row"]')
    if (!el) {
      if (tries > 0) scrollRelatedIntoView(tries - 1)
      return
    }
    // 'nearest', not 'start'/'end': scroll only the minimum needed to make the
    // whole target visible (none at all if it already fits on a wide
    // monitor) — see the scrollIntoView-axis rule in
    // .claude/rules/arrowjs-pitfalls.md for why `block: 'nearest'` is
    // required here too, so this never fights <main>'s own vertical scroll.
    el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
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

// scrollMainRightOneColumn — the click handler behind mainScrollRightHint
// (below): hides exactly the current left-most (at least partly visible)
// column of <main>'s own flex-row, one column per click, mirroring the
// reviewer request ("1x naar rechts = hide de linkerblok, nog een klik =
// ook de volgende"). Deliberately a PURE scroll-position change — it only
// ever sets <main>.scrollLeft, never state.drill/state.focusLevel/anything
// reactive, unlike expandColumn (which actively discards drilled columns).
// Works identically in list mode and diff mode: it walks <main>'s own
// direct children (whatever they are for the current mode) rather than
// anything diff/drill-specific.
function scrollMainRightOneColumn() {
  const main = document.querySelector('[data-testid="detail-panel"]')
  if (!main) return
  const mainLeft = main.getBoundingClientRect().left
  for (const col of main.children) {
    if (col.getAttribute('data-testid') === 'main-overflow-sentinel') continue
    const rect = col.getBoundingClientRect()
    // The first column whose right edge still reaches past <main>'s own
    // left (visible) edge is the current left-most one, fully or partially
    // on screen. Scroll exactly its own width further so that edge lands
    // flush with <main>'s left edge, i.e. hide it completely.
    if (rect.right > mainLeft + 1) {
      main.scrollLeft += rect.right - mainLeft
      return
    }
  }
}

// --- "hide a left column only when it genuinely doesn't fit" -----------------
//
// AppColumns' own geometry, as plain constants rather than a live measurement:
// its `left-6` inset, the `gap-6` between PrInfoPanel/<aside>/<main>, <main>'s
// own `gap-4` between its columns, and the two fixed left-column widths
// (<aside> `w-[26rem]`, pr-info-column `w-[39rem]`). Kept next to each other so
// a class change on either column is one edit here too.
const APP_COLUMNS_LEFT_PX = 24
const APP_COLUMNS_GAP_PX = 24
const MAIN_COLUMN_GAP_PX = 16
const PR_INDEX_COL_PX = 416
const PR_INFO_COL_PX = 624

// mainContentWidthPx — the real width <main>'s column flow WANTS, i.e. the sum
// of its own columns plus their gaps. Deliberately not `main.scrollWidth`:
// <main> is `flex-1`, so once everything already fits its scrollWidth is its
// (stretched) client width, which would report "needs the whole screen" exactly
// in the case this function exists to detect. The sentinel is skipped for the
// same reason scrollMainRightOneColumn skips it, and a zero-width child (a
// column hidden via `hidden`/`w-0`) claims no gap either.
//
// This IS a live DOM measurement, unlike every width in diff-card.md — but it
// measures the ALREADY RENDERED result and only feeds the visibility of columns
// that sit OUTSIDE <main> (whose own children are all `shrink-0` fixed widths),
// so it can't race the render it feeds: hiding/showing <aside> or the pr-info
// column never changes this number.
function mainContentWidthPx() {
  const main = document.querySelector('[data-testid="detail-panel"]')
  if (!main) return null
  let total = 0
  let cols = 0
  for (const col of main.children) {
    if (col.getAttribute('data-testid') === 'main-overflow-sentinel') continue
    const w = col.getBoundingClientRect().width
    if (w <= 0) continue
    total += w
    cols++
  }
  return total + Math.max(0, cols - 1) * MAIN_COLUMN_GAP_PX
}

// applyDiffColumnFit decides how many of the two left columns can stay visible
// next to <main>'s current column flow — see state.descriptionPinned/
// keepIndexInDiff for the reviewer request behind it.
//
// The order is the explicit one from that request: the PR-description column
// (the LEFT-most one) is dropped first, the pr-index only if it still doesn't
// fit after that. So the index is decided first (it survives longer) and the
// description gets whatever room is left over.
//
// Purely SHRINKING outside the click path: it can only ever keep something
// already visible, never make a column appear on its own — descriptionPinned is
// raised in enterDiff (a mouse click leaving stop 1), and keepIndexInDiff only
// while actually in diff mode. That is what keeps a resize/drill from
// spontaneously opening a column the reviewer never asked for.
function applyDiffColumnFit() {
  const content = mainContentWidthPx()
  if (content == null) return
  const available = window.innerWidth - APP_COLUMNS_LEFT_PX
  let need = content
  if (state.mode === 'diff') {
    state.keepIndexInDiff = need + APP_COLUMNS_GAP_PX + PR_INDEX_COL_PX <= available
    if (state.keepIndexInDiff) need += APP_COLUMNS_GAP_PX + PR_INDEX_COL_PX
  } else {
    // In list mode the pr-index is always visible, so it's part of the budget
    // rather than a candidate for hiding.
    need += APP_COLUMNS_GAP_PX + PR_INDEX_COL_PX
  }
  if (state.descriptionPinned) {
    state.descriptionPinned = need + APP_COLUMNS_GAP_PX + PR_INFO_COL_PX <= available
  }
}

// scheduleDiffColumnFit runs the fit twice on purpose: once synchronously
// against the layout as it stands (so a click that keeps the index doesn't
// first show one frame with it collapsed), and once after the next frame, when
// the mode switch/new columns have actually rendered and the measurement is
// exact.
function scheduleDiffColumnFit() {
  applyDiffColumnFit()
  requestAnimationFrame(applyDiffColumnFit)
}

// setupMainOverflowObserver keeps state.mainOverflowRight in sync with whether
// <main>'s own 1px sentinel (its last child, see DetailPanel) is currently
// scrolled out of view — i.e. whether there's more of <main>'s column flow
// to reach with a rightward scroll. Set up once <main> exists in the DOM
// (right after AppColumns(state)(app), below), observing the sentinel
// against <main> itself as the intersection root. This reacts to ANY
// change in <main>'s total content width (a column appearing/disappearing,
// a drilled column, the description column, a manual column-width resize)
// with no per-call-site bookkeeping — see the doc comment on
// state.mainOverflowRight. The sentinel's own `-ml-4` cancels out the
// flex gap-4 <main> puts before it, so its right edge lines up with the
// real last column's right edge instead of always sitting one gap further
// out (which would report overflow even once everything already fits).
function setupMainOverflowObserver() {
  const main = document.querySelector('[data-testid="detail-panel"]')
  const sentinel = document.querySelector('[data-testid="main-overflow-sentinel"]')
  if (!main || !sentinel) return
  const observer = new IntersectionObserver(
    ([entry]) => {
      state.mainOverflowRight = !entry.isIntersecting
      // A column opening further right (drilling, the comments panel) is
      // exactly the moment a kept-open left column stops fitting — this
      // observer already fires on ANY change of <main>'s content width, so it
      // doubles as the re-check trigger. Only while something is actually
      // being kept, and applyDiffColumnFit itself only ever shrinks from here,
      // so this can't oscillate: giving the space back reduces the overflow,
      // it never creates more.
      if (!entry.isIntersecting && (state.keepIndexInDiff || state.descriptionPinned)) {
        applyDiffColumnFit()
      }
      // Same reasoning for scrollRelatedIntoView (see its own doc comment):
      // the related panel can already own the keyboard (e.g. a fresh page
      // load restoring ?rel.foc=…) before the diff/code it sits next to has
      // actually finished rendering, so the overflow this scroll reacts to
      // only appears LATER — after the one-time relatedActive() transition
      // already fired. This observer already re-fires on that exact content-
      // width change, so it doubles as the retry trigger too.
      if (!entry.isIntersecting && relatedActive()) {
        scrollRelatedIntoView()
      }
    },
    { root: main, threshold: 0 },
  )
  observer.observe(sentinel)
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

// closeDrilledColumn closes the currently focused drilled column and steps
// focus back onto the diff of its parent column — extracted from onKeydown's
// ArrowLeft branch at state.focusLevel > 0 (see that branch's own comments for
// why each step is there) so Block.mjs's mouse-only "Sluit deze kolom" button
// (rendered on the currently focused drilled column — see
// blockCloseColumnButton) can call the exact same function instead of a
// second implementation, per the click-runs-the-same-function rule in
// mouse-navigation.md. A no-op with nothing drilled.
function closeDrilledColumn() {
  if (state.focusLevel <= 0) return
  state.drill = state.drill.slice(0, state.focusLevel - 1)
  state.drillCursor = state.drillCursor.slice(0, state.focusLevel - 1)
  state.focusLevel -= 1
  markDrillReturn(state.focusLevel)
  scrollFocusIntoView()
  if (state.focusLevel === 0) resetMainScroll()
  scrollChangeIntoView(false)
}

// leaveDiffToList leaves the diff session entirely and returns to the block
// list (stop 3 → stop 2) — extracted from onKeydown's ArrowLeft branch at
// state.focusLevel === 0 for the same reason as closeDrilledColumn:
// MainScrollLeftHint's click handler (stepMainLeftOneColumn, below) calls
// this directly instead of duplicating it.
function leaveDiffToList() {
  state.mode = 'list'
  state.drill = []
  state.drillCursor = []
  clearBlockDescFocus()
  clearRangeAnchor(0)
  resetMainScroll()
  scrollSelectedIntoView()
  refreshHints() // stepping back to the list hides the hints
}

// enterDescriptionFromList steps left out of the block list into stop 1 (the
// PR description) — extracted from onKeydown's ArrowLeft branch in list mode
// for the same reason as leaveDiffToList/closeDrilledColumn above:
// MainScrollLeftHint's click handler (stepMainLeftOneColumn, below) calls
// this directly instead of duplicating it.
function enterDescriptionFromList() {
  state.toggleFocused = false
  state.ignoreToggleFocused = false
  state.batchRowFocused = false
  state.pushTodoFocused = false
  state.staleRowFocused = false
  state.showDescription = true // step left out of the list into stop 1 (the description)
  state.blockIndexEntered = true
}

// stepMainLeftOneColumn — the click handler behind MainScrollLeftHint
// (below): exactly one ← step from wherever the keyboard currently is,
// mirroring stepMainRightOneColumn's own "one column per click" contract.
// Covers the whole diff → list → description chain; a no-op everywhere else
// (drilled column, list already showing the description) since
// canStepMainLeft() gates the button's very visibility for those cases.
function stepMainLeftOneColumn() {
  if (state.mode === 'diff' && state.focusLevel === 0) leaveDiffToList()
  else if (state.mode === 'list' && !state.showDescription) enterDescriptionFromList()
}

// canStepMainLeft — true while a further column exists to reveal to the LEFT
// of whatever currently owns the keyboard, i.e. while MainScrollLeftHint
// should show. Deliberately excludes a drilled column (state.focusLevel > 0)
// — that already has its own per-column "Sluit deze kolom" button
// (blockCloseColumnButton, Block.mjs) — and the list once the description is
// already open (nothing further left to reveal).
function canStepMainLeft() {
  if (state.mode === 'diff') return state.focusLevel === 0
  // descriptionPinned: in list mode a pinned-open description column is
  // already fully visible (see applyDiffColumnFit), so there is nothing left
  // to reveal — same reason showDescription suppresses this button.
  if (state.mode === 'list') return !state.showDescription && !state.descriptionPinned
  return false
}

// collapsedColumnHTML renders the narrow rail a non-focused column shrinks to
// once drilling has opened a column further right (see DetailPanel) — it
// reclaims horizontal room for the focused column. `level` is the column's own
// index in the virtual [top-level block, ...state.drill] list; clicking it
// calls expandColumn(level) to bring the keyboard focus back onto it.
// `drillIdx` (drilled columns only, null for the top-level rail) is exposed as
// data-drill-idx so it lines up with the open drill-column's own attribute.
function collapsedColumnHTML(b, level, testid, drillIdx = null) {
  return railButtonHTML({
    label: blockLabel(b),
    title: b.label || '',
    testid,
    dataDrillIdx: drillIdx,
    onClick: () => expandColumn(level),
  })
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
  const byId = allBlocksById()
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

// handleRelatedDrill is the click/Enter action for an Underlying-code child
// card (relatedCard/testsBar) or drill-hint chip. Everywhere it just calls
// drillIntoChild (nest the child as its own drilled column, see above) — ONE
// exception: a plain child card clicked (or Enter'd) from INSIDE the
// comment/chat-op-regel anchor's OWN Underlying-code panel
// (state.focusLevel === 1 && isCommentAnchorDrillActive(1) — the anchor
// itself, not a column drilled deeper from it, see openCommentAnchorDrill's
// own doc comment for why curBlock() stays the comment item at any depth)
// that ALSO has its own ordinary row in the blokken-index (state.blocks, as
// opposed to state.allBlocks — see jumpToBlockOwnPlace below for that
// distinction) jumps there instead of nesting. Reviewer request: "moet ik
// naar de normale plek toe... waar alle comments enzo bij staan" — the
// child's own place shows its full diff and its own, UNRESTRICTED comment
// scope (the anchor's onlyIds narrowing, see comments-panel.md, only ever
// applies at focusLevel===1 for the anchor's OWN comment — a jumped-to child
// is a completely ordinary top-level selection). A child with no such place
// (a resolved-method-call target — deliberately excluded from state.blocks
// even when it's a real, changed PR block, see recomputeLeftList's own doc
// comment — or a synthetic frame into a file this PR doesn't touch) has
// nowhere to jump to, so it keeps the existing nested-drill behavior
// unchanged; so does the tests_group toggle bar (its descriptor id never
// matches a real block id, so the lookup below simply fails for it) and a
// drill-hint chip chain (focusedChipChain in onKeydown calls drillIntoChild
// directly, not this function — chips already drill several levels in one
// go, a different shape from "open this one card").
//
// Deliberately the SAME function for both the click callback (RelatedPanel's
// drill prop) and Enter/Space in onKeydown — mouse-navigation.md's rule 1: a
// click never becomes a second, diverging implementation of what a key
// already does.
function handleRelatedDrill(child) {
  if (child && state.focusLevel === 1 && isCommentAnchorDrillActive(1)) {
    const idx = state.blocks.findIndex((b) => b.id === (child.blockId || child.id))
    if (idx >= 0) {
      jumpToBlockOwnPlace(idx)
      return
    }
  }
  drillIntoChild(child)
}

// jumpToBlockOwnPlace closes the comment-anchor sub-view (see
// handleRelatedDrill above) and lands on a plain top-level block at `idx` in
// state.blocks exactly as if the reviewer had selected it from the sidebar
// and stepped in — mode:'diff', focusLevel:0, no drill stack, its first
// change group. Mirrors two existing precedents rather than inventing a
// third shape:
// - closeCommentAnchorDrillIfOwned() (already resets state.drill/
//   drillCursor/focusLevel and clears commentAnchorDrillFor/
//   commentAnchorEntered) runs SYNCHRONOUSLY before state.selected changes,
//   so there is no in-between tick where state.selected already points at
//   the new block while state.drill/focusLevel still reflect the old anchor.
// - The rest mirrors openTask (the "Taken" row's own jump-to-a-block action):
//   a direct state.mode='diff' (not the fuller enterDiff(), whose
//   showDescription/keepIndexInDiff side effects are for stepping FROM list
//   mode's own → and don't apply here), resetMainScroll(), best-effort
//   ensureCode. Unlike openTask there is no specific comment/unit to land
//   on — the click is on the CHILD, which may carry no comment of its own —
//   so this lands on the block's plain default first group, same as any
//   other fresh block selection.
function jumpToBlockOwnPlace(idx) {
  const target = state.blocks[idx]
  closeCommentAnchorDrillIfOwned()
  leaveRelated()
  state.selected = idx
  state.mode = 'diff'
  state.rangeAnchor = null
  state.gran = 'group'
  state.change = 0
  resetMainScroll()
  if (target && !target.code) ensureCode(target)
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
// An active Shift+arrow range selection (see rangeUnit/isRangeGran) widens
// the unit to the whole selected range, so a comment posted on it becomes a
// real multi-line range comment (unitLineRange/startLine/endLine below
// already support that — GitHub's own multi-line review comments).
function commentTarget() {
  const b = focusedBlock()
  // A synthetic comment-index item (kind:'comment') has no file/line to
  // anchor a NEW comment to — this only matters via the `/`-menu's "Comment
  // plaatsen" (PR_COMMANDS), which doesn't itself check what's selected;
  // return null so placeComment's existing "nothing to anchor to" no-op
  // applies, same as no block at all.
  if (!b || b.kind === 'comment') return null
  const rows = blockRows(b)
  const level = state.focusLevel
  const cur = level > 0 ? state.drillCursor[level - 1] || { change: 0, gran: 'group' } : null
  const gran = level > 0 ? cur.gran : state.mode === 'diff' ? state.gran : 'group'
  const idx = level > 0 ? cur.change : state.mode === 'diff' ? state.change : 0
  const anchor = level > 0 ? cur.rangeAnchor : state.mode === 'diff' ? state.rangeAnchor : null
  // A TRANSLATION block never drills (see blocks-and-ingest.md — a
  // translation child is always a read-only leaf value view, never a
  // drillable PR block), so navUnitsOf's TRANSLATION branch only ever
  // applies to the top-level cursor (level === 0) — passing `b` through is
  // still correct either way.
  const units = navUnitsOf(b, rows, gran)
  const unit = isRangeGran(gran) ? rangeUnit(units, idx, anchor) : units[idx]
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
      oldStartLine: 0,
      oldEndLine: 0,
      newStartLine: 0,
      newEndLine: 0,
    }
  let code = ''
  for (let i = unit.start; i <= unit.end; i++) {
    const r = rows[i]
    const text = r && (r.right != null ? r.right : r.left)
    if (text != null) code += (code ? '\n' : '') + text
  }
  const { startLine, endLine, side } = unitLineRange(b, rows, unit)
  const { oldStartLine, oldEndLine, newStartLine, newEndLine } = unitBothLineRanges(b, rows, unit)
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
    // Both sides' own line ranges (0 when that side has no rows in the unit),
    // independent of `side`'s pick above — only consumed so far by
    // RelatedPanel's claudeContextBlock (the invisible chat-prompt context; see
    // claude-chat-panel.md), which wants "old" and "new" together rather than
    // GitHub's single-side anchor.
    oldStartLine,
    oldEndLine,
    newStartLine,
    newEndLine,
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

// unitBothLineRanges is unitLineRange's counterpart for a caller that wants
// BOTH sides' line ranges together (old ánd new), instead of the single side
// GitHub anchoring needs. Same row-counting algorithm, just tracking two
// independent counters/ranges instead of picking one via `side`. A side with
// no content in the unit (e.g. a pure addition has no old range) comes back
// as 0/0, same "unknown" convention as unitLineRange's own fallback.
function unitBothLineRanges(b, rows, unit) {
  const c = b && b.code
  if (!c || !c.new || !c.old || !unit)
    return { oldStartLine: 0, oldEndLine: 0, newStartLine: 0, newEndLine: 0 }
  let newNo = c.new.start
  let oldNo = c.old.start
  let oldStartLine = 0,
    oldEndLine = 0,
    newStartLine = 0,
    newEndLine = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r) continue
    const inUnit = i >= unit.start && i <= unit.end
    if (inUnit && r.right != null) {
      if (!newStartLine) newStartLine = newNo
      newEndLine = newNo
    }
    if (inUnit && r.left != null) {
      if (!oldStartLine) oldStartLine = oldNo
      oldEndLine = oldNo
    }
    if (r.right != null) newNo++
    if (r.left != null) oldNo++
  }
  return { oldStartLine, oldEndLine, newStartLine, newEndLine }
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
//
// A synthetic PR-wide comment-index item (kind:'comment', see
// recomputeLeftList/commentBlockItem) gets its own sentinel scope
// (`{ none: true }`) instead of falling through to null. commentTarget()
// already returns null for such an item, but for a DIFFERENT reason (its own
// "nothing to anchor a NEW comment to" no-op, load-bearing for placeComment —
// see its own comment) — reusing that null here would be indistinguishable
// from "nothing selected yet", which is exactly the bug: RelatedPanel's
// recomputeView reads a null scope as "no filter" and shows every anchored
// comment of the PR next to a comment that has no code anchor at all. So this
// reads focusedBlock() directly, ahead of commentTarget(), to tell the two
// apart.
function commentScope() {
  const b = focusedBlock()
  // prComment rides along on the same sentinel scope so RelatedPanel's
  // syncClaudeAnchorForSelection/chatAnchorComment (see their own doc
  // comments) can anchor the embedded Claude column on THIS PR-wide item
  // exactly like they already do for a block-scoped comment — see
  // "Chat met Claude" (prCommentCommandsFor, startPrCommentChat).
  if (b && b.kind === 'comment') return { none: true, prComment: b.comment }
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
    // firstGroupRowStart — the aligned-row start of THIS block's own first
    // changed group (groupsFor(b)[0], the same source the list-mode preview
    // uses), independent of the currently selected granularity/change index.
    // RelatedPanel.commentUnder's only use is the "pin to the first changed
    // row" fallback below — see comments-panel.md.
    firstGroupRowStart: (groupsFor(b)[0] || {}).start ?? -1,
    // onlyIds — set only while a "Comments op regels" index item's own
    // drilled anchor column owns the cursor (isCommentAnchorDrillActive):
    // narrows the block-scoped comment index down to exactly the comment(s)
    // that row stands for (b.comments, see commentGroupKeyOf), instead of
    // every comment commentUnder's row-range containment would otherwise
    // surface on this unit. Reviewer request: "als ik navigeer door comments
    // op regels wil ik aan de rechterkant alleen die comment en chat zien" —
    // the diff card and Onderliggende code stay as-is (commentAnchorColumnHidden
    // is unrelated to this), only OTHER comment threads on the same unit are
    // suppressed. See "Comments op regels shows only its own comment" in
    // comments-panel.md.
    onlyIds: isCommentAnchorDrillActive(1) ? commentAnchorOnlyIds() : null,
    // The unit's real source line range on BOTH sides (see unitLineRange/
    // unitBothLineRanges) — RelatedPanel.commentUnder's only way to
    // best-effort scope an unpinned/never-anchored comment (rowStart -1) to
    // one specific unit instead of every unit of the block, since its own
    // aligned row is gone but its recorded `line` (see createComment) still
    // is not. See "Best-effort line matching for an unpinned comment" in
    // comments-panel.md.
    oldStartLine: t.oldStartLine,
    oldEndLine: t.oldEndLine,
    newStartLine: t.newStartLine,
    newEndLine: t.newEndLine,
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

// The "Taken" keyboard cursor (state.taskFocus, see stepTaskFocus) only exists
// WITHIN stop 1: it is a position inside the PR-description column, so the
// moment that column stops owning the keyboard the cursor must be gone —
// otherwise coming back to stop 1 later lands on a stale row instead of on the
// description card, and the card's own focus ring stays suppressed by a cursor
// nobody can see (prInfoCard reads `!state.taskFocus`). The ArrowRight branch in
// onKeydown clears it itself; this watch covers every OTHER way stop 1 loses
// ownership (a mouse click into a diff, enterDiff, an auto-selection).
watch(
  () => state.showDescription,
  (shown) => {
    if (!shown) state.taskFocus = ''
  },
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

// ── Footer: focused unit + AI description ───────────────────────────────────
// The footer shows (1) the inline diff of the focused single-row unit and
// (2) a short Dutch AI description of the focused line/group unit — every
// such unit, not just an if-statement (the explain_code workflow, Opus).
// Both follow the column that owns the diff keyboard — the top-level block on
// focusLevel 0 (state.gran/state.change) or a drilled column's own
// drillCursor entry — and are pushed into plain
// state.footerUnit/state.footerExplain by the decoupled watch below, so
// Footer.mjs never reads blockRows/b.code itself (the co-subscriber pitfall,
// see conventions.md).

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

// EXPLAIN_PROMPT_VERSION rides along in the explain-request hash (see
// footerUnitInfo below) purely so a change to explain_code's prompt text can
// invalidate every previously generated explanation — a stored row's
// codeHash simply stops matching, so the unit lazily re-requests a fresh
// description the next time it's focused (the same "new commit → new hash"
// path the codeHash already relies on, just triggered by a prompt change
// instead of a code change). No backend migration/bulk-delete needed. Bump
// this whenever the prompt changes in a way that changes the desired output
// (e.g. v2: capped the answer to ~40 words / ~275 characters so it reliably
// fits the footer's line-clamp-2 instead of being cut off — see
// modules/claude/prompts/explain_code.md).
const EXPLAIN_PROMPT_VERSION = 'v2'

// explainContext returns the focused block's new-side source (old side for a
// pure removal), truncated, as prompt context for the LLM.
function explainContext(b) {
  const c = b && b.code
  const text = (c && ((c.new && c.new.text) || (c.old && c.old.text))) || ''
  return text.split('\n').slice(0, EXPLAIN_CONTEXT_LINES).join('\n')
}

// MAX_EXPLAIN_LINES — the size cap on the automatic AI description
// (explain_code) footerUnitInfo triggers, in rows. An ordinary 'group' unit
// is already capped at 5 rows (MAX_GROUP, changeGroups), but a Shift+arrow
// range (rangeUnit) has no such ceiling — it can merge arbitrarily many
// groups/lines. Reindert's explicit answer to "how big may the auto-sent
// context get": "Uitleg maximaal 10 regels" — a range larger than this still
// shows the ordinary diff preview in the footer, it just gets no automatic
// AI text. Deliberately does NOT limit the Claude-chat context
// (claudeContextBlock, RelatedPanel.mjs): that only ever sends on an
// explicit reviewer send, unlike this debounced, keypress-free trigger.
const MAX_EXPLAIN_LINES = 10

// footerUnitInfo computes everything the footer needs about the focused unit:
// the aligned rows spanned by the unit for the inline diff — one row for a
// line/call unit (always single-row), one row per changed line for a
// multi-row group, so the footer can show a per-line breakdown of "what
// changed" for the whole selected block/group, not just a one-liner — and,
// for ANY line/group unit with actual code (no longer gated on containing an
// if-statement — see the "Diepgravend onderzoek" change), the explain-request
// descriptor (blockId + unitKey in the commentPath codeRef shape +
// code/context + hash). Follows focusedBlock() and the focused column's own
// cursor, so a drilled column previews its own unit.
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
  // Same merged-range reuse as callScopeMethods/groupLineRange — a Shift+arrow
  // selection widens the previewed rows to the whole selected range, not just
  // the lone unit under the cursor. focusedActiveUnit() already resolves the
  // correct { start, end } for either the top-level cursor or the focused
  // drilled column's own cur.rangeAnchor.
  const unit = focusedActiveUnit()
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
  // A Shift+arrow range has no upper size limit of its own (unlike an
  // ordinary 'group', capped at MAX_GROUP=5 rows by changeGroups) — an
  // unsolicited explain_code call over an arbitrarily large, reviewer-merged
  // range is a real cost/latency risk the reviewer never asked for (this
  // fires automatically, debounced, with no keypress). Reindert's explicit
  // answer: cap it at MAX_EXPLAIN_LINES=10 rows; a bigger selection still
  // gets the ordinary diff preview above (unitRows), just no auto-generated
  // AI text. Starting a Claude chat about a bigger range stays possible —
  // that is an explicit reviewer action (claudeContextBlock), not this
  // automatic one.
  if (unit.end - unit.start + 1 > MAX_EXPLAIN_LINES) return info
  let code = ''
  for (let i = unit.start; i <= unit.end; i++) {
    const r = rows[i]
    const t = r && (r.right != null ? r.right : r.left)
    if (t != null) code += (code ? '\n' : '') + t
  }
  // Nothing to explain for a blank/whitespace-only unit (e.g. a lone filler
  // row) — every other unit now gets a description, not just an if-statement.
  if (!code.trim()) return info
  const context = explainContext(b)
  info.explain = {
    blockId: b.id,
    file: b.file,
    label: b.label,
    gran: cur.gran,
    // Both start AND end — a merged Shift+arrow range can share a start row
    // with a different range/unit (or with an unmerged single line whose
    // own start happens to coincide), so start alone is no longer a unique
    // key once ranges exist.
    unitKey: `${cur.gran}-${unit.start}-${unit.end}`,
    code,
    context,
    codeHash: fnv1a(EXPLAIN_PROMPT_VERSION + '|' + code + '\n ' + context),
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
      body: JSON.stringify({ pr: state.pr, repo: state.repo || undefined, ...req }),
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
// state.footerExplain and auto-schedules the AI generation for any line/group
// unit with code that has no (matching-hash) explanation yet. A stored row
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
  // A new unit/explanation can just as well change footer-diff's own scroll
  // hints (a multi-row group at/near the FOOTER_MAX_PX cap, or a Shift-range
  // with no row ceiling of its own) — see refreshHints' own comment.
  refreshScrollHints()
}

function computeFooterSnapshots() {
  const info = footerUnitInfo()
  // Kept explicitly null (not an empty array) when there's nothing to show —
  // both for the updateFooter() truthiness check above and to dodge the
  // arrow.js single↔array slot pitfall in Footer.mjs (see conventions.md).
  state.footerUnit = info && info.unitRows.length ? info.unitRows : null
  const req = info && info.explain
  // "Live AI assistent uit" means no automatic Claude call at all, so the AI
  // description of the focused unit is skipped along with the risk check —
  // the reviewer's own words: "als dat uit staat, ook geen live descriptions
  // toevoegen aan geselecteerde dingen". An already-generated description is
  // hidden too, not just future ones: the switch should read as "the
  // assistant is quiet", not "quiet from now on". The unit's own code preview
  // is untouched — that is not AI output. See src/autowarn.mjs.
  if (!req || !autoWarn.enabled) {
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
    // Flipping the "Live AI assistent" switch must repaint the footer at once
    // (the description appears/disappears), so it is a dependency of this
    // watch like any other — named INLINE, per the arrow.js watch rule.
    autoWarn.enabled,
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
      state.underlyingIds,
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
    for (const b of state.blocks) {
      // The sidebar PILL of a test_class row deliberately shows a NARROWER
      // number than what feeds the PR-wide total (methods' own rows only, not
      // their nested subtree — see blockApproveCount's own comment) —
      // map[b.id] is only ever read for per-row display (BlockList.mjs's
      // approvalPill/isFullyApproved), never for a sum, so this divergence is
      // safe and deliberate.
      map[b.id] =
        b.kind === 'test_class' ? blockApproveCount(b) : subtreeApproveCount(b)
    }
    state.approvalSummaries = map
    // The PR-wide header count is a UNION over the whole tree, not the sum of
    // the pills above — a block shared by several subtrees counts once. See
    // prWideApproveTotal.
    state.approvalTotal = prWideApproveTotal()
    notifyFullyApprovedIfNeeded()
  },
)

// commentScopeKeys returns the set of "file|label" anchor keys that count as
// "underlying code" of a sidebar row b, for the comment-activity indicator
// (state.commentActivity, watch below) — mirrors nestedPrBlocks/
// subtreeApproveCount's own subtree definition exactly, so "there's a comment
// in the underlying code" means the same tree as "there's still something to
// approve in the underlying code": the block itself plus every PR block
// nested under it (relation children, resolved-call definitions, resolved
// covers targets, transitively). A test_class row (see testClassRowItem) has
// no own file:label of its own — it's a union over every one of its
// `.methods`, each with its own subtree, deduped via a single Set shared
// across all methods (mirrors nestedPrBlocks's own cycle guard). A synthetic
// comment-index item (kind:'comment') has no code of its own to roll up —
// its own thread already shows directly, so it returns null (no indicator).
function commentScopeKeys(b) {
  if (!b || b.kind === 'comment') return null
  const keyOf = (x) => x.file + '|' + x.label
  if (b.kind === 'test_class') {
    const seen = new Set()
    const keys = new Set()
    for (const m of b.methods || []) {
      keys.add(keyOf(m))
      for (const kid of nestedPrBlocks(m, seen)) keys.add(keyOf(kid))
    }
    return keys
  }
  return new Set([keyOf(b), ...nestedPrBlocksCached(b).map(keyOf)])
}

// Bridge comment + code state → per-row comment-activity summaries the
// sidebar reads (state.commentActivity → BlockList.mjs's commentActivityPill).
// Decoupled from the render for the same reason as approvalSummaries/
// setRelated/setCommentScope: a plain snapshot instead of each block's
// reactive b.code, so the sidebar never becomes a co-subscriber on the
// selected block's b.code (the "stuck on loading" race, see conventions.md).
// The getter lists its deps INLINE: the block/relation/call structure (which
// blocks even exist to roll up) plus commentListSnapshot() (an unconditional
// read of cs.list, RelatedPanel.mjs) — the actual per-row rollup happens in
// the callback via commentScopeKeys + commentActivitySummary.
//
// Alongside the existing per-ROW entry (state.blocks id → summary), a
// test_class row (see testClassRowItem/recomputeLeftList) ALSO gets one
// entry per individual METHOD (method.id → summary) — TestMethodsColumn.mjs
// reuses BlockList.mjs's own commentActivityPill per method row, and that
// needs a per-method summary, not the row-wide union commentScopeKeys(b)
// already returns for the test_class row itself. commentScopeKeys(m) works
// unchanged for this: a method is an ordinary PR block (no .kind), so it
// falls into commentScopeKeys' generic branch (its own anchor + its own
// nestedPrBlocks subtree) — exactly the same subtree shape as any other
// top-level block's own entry, just scoped to one method instead of the
// whole class. No second `matchesRow` argument is passed here (unlike
// lineChildSummaries' per-DIFF-LINE use of that param): this is a per-BLOCK
// summary like every other state.commentActivity entry, not a per-row-within-
// a-block one, so there's nothing to restrict — the whole method's own
// comments + its subtree's comments should count, exactly like the class
// row's own union already includes all of them.
// No new reactive dependency: nestedPrBlocks/directChildBlocks only read
// state.allBlocks/state.relations/callRows(→state.callResolve)/
// testCoverRows(→state.testCovers) — all already inline above — and never a
// block's own b.code, so this can't introduce the "stuck on loading" race.
watch(
  () => [
    state.blocks,
    state.allBlocks,
    state.underlyingIds,
    state.relations,
    state.callResolve,
    state.testCovers,
    commentListSnapshot(),
  ],
  () => {
    const map = {}
    for (const b of state.blocks) {
      const keys = commentScopeKeys(b)
      const summary = keys ? commentActivitySummary(keys) : null
      if (summary) map[b.id] = summary
      if (b.kind === 'test_class') {
        for (const m of b.methods || []) {
          const mKeys = commentScopeKeys(m)
          const mSummary = mKeys ? commentActivitySummary(mKeys) : null
          if (mSummary) map[m.id] = mSummary
        }
      }
    }
    state.commentActivity = map
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
  if (ctx.mode !== 'diff') return t('dit block')
  if (ctx.b && ctx.b.category === 'TRANSLATION') return t('deze vertaling')
  if (ctx.gran === 'call') return t('deze call')
  if (ctx.gran === 'line') {
    if (ctx.anchor != null && ctx.anchor !== ctx.change)
      return t('deze {n} regels', { n: Math.abs(ctx.change - ctx.anchor) + 1 })
    return t('deze regel')
  }
  return t('deze regels')
}

// approveTargetRows returns the changed row indices an approve action covers now:
// the current navigation unit's rows in diff mode (merged with an active
// Shift+arrow range selection, see rangeUnit/isRangeGran), or the whole block
// in list mode (where there's no active unit). Takes an explicit ctx (default
// approveContext()), same reason as approveNoun.
function approveTargetRows(ctx = approveContext()) {
  const b = ctx.b
  if (!b) return []
  const rows = blockRows(b)
  const all = changedRows(rows)
  if (ctx.mode !== 'diff') return all
  const units = navUnitsOf(b, rows, ctx.gran)
  const unit = isRangeGran(ctx.gran) ? rangeUnit(units, ctx.change, ctx.anchor) : units[ctx.change]
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
// `auto` (default false, only passed `true` by spaceKey below) skips the
// postApprove confirm menu and jumps straight to the next unapproved unit
// instead — see afterApproveAction's own `auto` doc comment.
// activeUnitIsReference reports whether the unit an approve action would act
// on is a reference unit (an unchanged line carrying only a resolved call, see
// referenceRows): landable, but with nothing to approve. Used both to make
// approving a no-op and to leave the "Keur ... goed" item out of the palette
// entirely, so the reviewer is never offered an action that can't do anything.
function activeUnitIsReference(ctx = approveContext()) {
  const b = ctx.b
  if (!b || ctx.mode !== 'diff') return false
  const unit = navUnitsOf(b, blockRows(b), ctx.gran)[ctx.change]
  return !!(unit && unit.ref)
}

function toggleApprove(auto = false) {
  const ctx = approveContext()
  const b = ctx.b
  if (!b) return
  // Nothing to approve on a reference unit — see activeUnitIsReference.
  if (activeUnitIsReference(ctx)) return
  if (ctx.mode === 'diff' && ctx.gran === 'call') {
    return toggleCallApprove(b, ctx.change, auto)
  }
  const target = approveTargetRows(ctx)
  if (!target.length) return
  const set = approvedRowSet(b)
  // allIn (and thus the label's "goedkeuren vs. intrekken" choice, see
  // COMMANDS' 'approve' item) is deliberately computed on the RAW target —
  // never on a swept one — so the sweep below can't itself flip whether this
  // action counts as an approve or a retract.
  const allIn = target.every((i) => set.has(i))
  // One-way sweep (see sweepBracketOnlyForward, Block.mjs): only on the ADD
  // path does approving a line/group also pull in any directly-FOLLOWING
  // bracket-only row (a lone `});`/`},`/etc.) — retracting only ever affects
  // the rows the reviewer actually navigated to, never an auto-swept
  // neighbor.
  const applyTo = allIn ? target : sweepBracketOnlyForward(blockRows(b), target)
  applyTo.forEach((i) => (allIn ? set.delete(i) : set.add(i)))
  b.approvedRows = [...set].sort((x, y) => x - y)
  persistApproval(b)
  // allIn was false → this action just ADDED approval (not revoked it).
  return afterApproveAction(!allIn, b.id, auto)
}

// toggleTestClassApproval is the class-level counterpart of Block.mjs's top
// checkbox (toggleBlockApproval): approves — or, if already fully approved,
// clears — every method of a test_class row (see testClassRowItem/
// "Grouping test methods per class" in test-class-grouping.md) in one action,
// from the checkbox in the methodes-kolom header (TestMethodsColumn.mjs).
// Unlike a single block, most methods here have never had their code fetched
// (only the ACTIVE method loads lazily, see curBlock()/ensureCode) — so
// blockRows(m)/changedRows(...) would be empty for the rest and approving
// would silently approve nothing. Approving therefore first awaits every
// method's code via ensureCode (a no-op for one already loaded/loading —
// see codeRequested), THEN computes each method's full changed-row set.
// Same scope decision as the block checkbox: no afterApproveAction/postApprove
// menu, each method persisted individually through the existing single-block
// `approve` Signal (persistApproval) — never a direct write.
async function toggleTestClassApproval(row) {
  const s = state.approvalSummaries && state.approvalSummaries[row.id]
  const approving = !(s && s.total > 0 && s.done === s.total)
  if (approving) await Promise.all(row.methods.map((m) => ensureCode(m)))
  for (const m of row.methods) {
    m.approvedRows = approving ? changedRows(blockRows(m)) : []
    persistApproval(m)
  }
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
// re-renders the checkmark/circle indicators. `auto` is forwarded straight
// through to afterApproveAction (see toggleApprove's own doc comment).
function toggleCallApprove(b, change = state.change, auto = false) {
  const rows = blockRows(b)
  const unit = navUnitsOf(b, rows, 'call')[change]
  // A reference unit (an unchanged line that only carries a call, see
  // referenceRows) has nothing to approve — landing on it is for stepping
  // INTO its underlying code, not for signing anything off.
  if (!unit || unit.ref) return
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
  return afterApproveAction(approving, b.id, auto)
}

// unitFullyApproved reports whether every changed row (or, at gran==='call', the
// one call segment) a navigation unit covers is approved — the same scoping
// approveTargetRows uses, so "next not-approved" agrees with what an approve
// action would actually cover. `all` is the block's changedRows, passed in so
// callers that already have it don't recompute it per unit.
function unitFullyApproved(b, unit, gran, all) {
  // A reference unit — an unchanged line that only carries a resolved call
  // (see referenceRows/withReferenceUnits) — has no changed rows at all, so
  // there is nothing in it to approve and it must never read as "still open"
  // to findNextUnapproved. The group/line branch below already concludes that
  // via its empty rowsInUnit; 'call' needs saying explicitly, since
  // callUnitApproved keys off approvedRows/approvedCalls instead.
  if (unit && unit.ref) return true
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
  const units = navUnitsOf(b, rows, gran)
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
//     through the current drill stack's ancestors, RETURNING to the nearest
//     one that still has an unapproved unit of its own — see "Returning to
//     an unapproved ancestor" below.
//  4. Failing that (every ancestor up to the top level is itself fully
//     approved), UP through the current drill stack again, this time trying
//     each ancestor's next not-yet-tried sibling child.
//  4b. Failing that, and only at the top level, the REMAINING methods of the
//     current test_class row (see testClassRowItem/recomputeLeftList).
//  5. Failing that (the entire current top-level block's subtree is done, or
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
//
// Returning to an unapproved ancestor (step 3, reviewer request): approving
// everything reachable BELOW a drilled column (steps 1+2 above) doesn't mean
// the column you drilled IN FROM is itself done — it may still have its own
// unapproved rows the reviewer never got to before drilling deeper. Step 3
// walks the drill stack from the deepest ancestor up, and on the first one
// with `firstUnapprovedOwnUnit(parent, 'group', -1) !== null` returns a plan
// landing on THAT ancestor — flagged `isReturn: true` so the postApprove menu
// labels its "continue" item "Ga terug" instead of "Ga door" (see
// POSTAPPROVE_COMMANDS). It lands on the ancestor's own SAVED cursor (its
// `state.drillCursor` entry, or state.gran/state.change for the top-level
// block) — "waar ik als laatst was", not that ancestor's own next unapproved
// line — because drilling further IN never touches an ancestor's cursor (see
// the comment at the loop itself). Only when NO ancestor up to the top level
// has unapproved own work does the function fall through to step 4, the
// pre-existing sibling-walk (unchanged).
//
// Steps 2, 4 and 4b deliberately do NOT require `inDiff` (unlike step 1) —
// this used to be a real bug: approving a whole block/test-method straight
// from the "Start" list (never having pressed → into its diff at all — the
// realistic way to review a freshly ADDED, single-shot test method) skipped
// this entire function's "descend into Onderliggende code" / "walk the rest
// of this test class's methods" logic, because all of it sat nested inside
// one `if (focused && inDiff)` gate. The reviewer then landed on "Keur de
// HELE PR goed / Wijs de PR af" (see openMenu below) while sibling methods
// with 0/N approved rows sat right there in the same methods column — see
// the "No more 'next'" section in keyboard-navigation.md. Only step 1
// genuinely needs a diff cursor to resume from (state.gran/state.change, or
// a drilled column's own drillCursor): in list mode there IS no cursor
// within the block to search forward from — approving "the whole block"
// from the list already covers every one of its own changed rows in one go,
// so step 1 is correctly a no-op there, not merely skipped. Steps 2/4/4b are
// about the currently selected block's own children/siblings, which exist
// (and can be missing approval) whether or not the reviewer ever stepped
// into its diff. Step 3 (returning to an ancestor) is likewise independent of
// `inDiff` — it only ever fires at level > 0 anyway, which already implies a
// diff cursor exists.
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
  }

  if (focused) {
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
    // Only once the focused column's own subtree is exhausted (its own rows,
    // just checked above, PLUS every Underlying-code descendant, the loop
    // right above this one): walk UP the drill stack and return to the
    // nearest ANCESTOR that itself still has an unapproved unit of its OWN
    // (not a sibling, not a descendant — reviewer request: "als ik een
    // onderliggende code goedkeur, dan wil ik terug naar de bovenliggende
    // code als dat nog niet is goedgekeurd; als die al goedgekeurd is en er
    // is nog een bovenliggende code, ga dan daarnaartoe"). Deepest ancestor
    // first (lvl = level down to 1) so a partially-reviewed immediate parent
    // wins over a grandparent. `parent` here means exactly what the sibling
    // loop below calls `parent` — the ancestor one level up from `state.drill[lvl-1]`.
    // Lands on that ancestor's OWN SAVED cursor — "waar ik als laatst was",
    // not its next unapproved line: state.drillCursor[lvl-2] (or
    // state.gran/state.change for the top-level block) is never touched by
    // drilling further IN (drillIntoChild only ever PUSHES a fresh entry for
    // the new deepest level), only by an explicit navigation action AT that
    // same level — so it still holds exactly the position the reviewer left
    // before descending. Defensively clamped in case a reload since then
    // shrank that granularity's unit count. Marked `isReturn: true` so the
    // postApprove menu can label this "Ga terug" instead of "Ga door" (see
    // POSTAPPROVE_COMMANDS) — every other branch of this function never sets
    // that flag. Only meaningful at level > 0, same as the sibling loop.
    for (let lvl = level; lvl > 0; lvl--) {
      const parent = lvl > 1 ? state.drill[lvl - 2] : curBlock()
      if (parent && firstUnapprovedOwnUnit(parent, 'group', -1) !== null) {
        const savedCur = lvl > 1 ? state.drillCursor[lvl - 2] || { change: 0, gran: 'group' } : { gran: state.gran, change: state.change }
        const units = navUnitsOf(parent, blockRows(parent), savedCur.gran)
        const change = units.length ? Math.min(savedCur.change, units.length - 1) : 0
        return {
          root: state.selected,
          path: state.drill.slice(0, lvl - 1),
          gran: savedCur.gran,
          change,
          isReturn: true,
        }
      }
    }

    // Only meaningful at level > 0 (a drilled column has ancestors to walk
    // sideways through) — at level === 0 this loop is a no-op by construction
    // (the `lvl > 0` condition never holds), so pulling it out of the
    // `inDiff` gate above changes nothing for the list-mode case; a drilled
    // column always implies inDiff anyway (level > 0 ⇒ inDiff).
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

  // Continue through the REMAINING methods of the same test_class row (see
  // testClassRowItem/recomputeLeftList) before falling through to a
  // different top-level row below — decision: "doorlopen mag" (see
  // keyboard-navigation.md). Only at the top level (level === 0): a
  // drilled column can never itself be "inside" a class's methods column.
  // Independent of `focused`/`inDiff` for the same reason as steps 2/3 above.
  if (level === 0) {
    const row = curTestClassRow()
    if (row) {
      for (let mi = state.classMethodSel + 1; mi < row.methods.length; mi++) {
        const found = await firstUnapprovedInSubtree(row.methods[mi])
        if (found) {
          return { root: state.selected, methodIdx: mi, path: found.path, gran: found.gran, change: found.change }
        }
      }
    }
  }

  for (let idx = state.selected + 1; idx < state.blocks.length; idx++) {
    const candidate = state.blocks[idx]
    // A test_class row has no own changed rows — search its methods in
    // order instead of calling firstUnapprovedInSubtree on the row itself
    // (which assumes a real PR block with its own blockRows/code).
    if (candidate.kind === 'test_class') {
      for (let mi = 0; mi < candidate.methods.length; mi++) {
        const found = await firstUnapprovedInSubtree(candidate.methods[mi])
        if (found) {
          return { root: idx, methodIdx: mi, path: found.path, gran: found.gran, change: found.change }
        }
      }
      continue
    }
    const found = await firstUnapprovedInSubtree(candidate)
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
// of dropping you into a block's diff or a drilled child. A test_class plan
// (`target.methodIdx`) keeps `state.testColumnFocused` TRUE here — the
// reviewer was already working the methodes-kolom (that's how they approved
// a method from the list in the first place), so the column must stay
// focused/highlighted and keep owning ↑/↓, exactly like the non-keepList
// branch below already does. Resetting it to false used to silently kick
// keyboard ownership back to the pr-index right after the first auto-jump.
function applyNextUnapproved(target) {
  if (target.keepList) {
    state.selected = target.root
    if (target.methodIdx != null) {
      state.classMethodSel = target.methodIdx
      state.testColumnFocused = true
    }
    scrollSelectedIntoView()
    return
  }
  const sameRoot = target.root === state.selected
  // A test_class plan (see testClassRowItem/recomputeLeftList) also carries
  // WHICH method to land on — "same root" alone isn't enough to decide
  // whether this is a genuine "stay put" vs. a fresh landing: moving to a
  // different method within the SAME class row still needs a fresh drill
  // stack (a different method's own Onderliggende-code tree), exactly like
  // moving to a different root would.
  const sameMethod = target.methodIdx == null || target.methodIdx === state.classMethodSel
  if (!sameRoot || !sameMethod) {
    state.selected = target.root
    if (target.methodIdx != null) state.classMethodSel = target.methodIdx
    state.drill = []
    state.drillCursor = []
    state.focusLevel = 0
  }
  if (target.methodIdx != null) state.testColumnFocused = true
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
  if (sameRoot && sameMethod && common === target.path.length) markDrillReturn(common)
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
// COMMANDS/REVIEW_CHOICE_COMMANDS): fully done → just "Keur de HELE PR goed"; not
// yet fully done → the extra choice "Wijs de PR af" (which itself needs a
// non-empty reason, see the 'reviewReject' menu mode).
// `keepList` and `blockId` are both captured synchronously, right here (resp.
// by the caller, see toggleApprove/toggleCallApprove) — before the async
// findNextUnapproved gap — so they reflect the mode/block the reviewer was
// actually in when they ran the approve action, not whatever state happens to
// be once the promise resolves.
// EXCEPTION 1 — next unit stays in the SAME block, no menu: if the plan's
// landing block (the last entry of `path`, or — an empty `path` — the
// top-level block at `root`) is the very block that was just approved
// (`blockId`), this is exactly findNextUnapproved's step-1 branch ("forward
// within whichever column currently owns the keyboard") — no block change,
// just the next unapproved line/call/group in the block the reviewer is
// already looking at, TOP-LEVEL OR DRILLED. Asking "ga door of niet" there is
// pure friction, so this jumps straight there via applyNextUnapproved instead
// of opening the postApprove menu. Any other outcome (down into a child's
// subtree, up to a sibling, or across to a different top-level block) still
// opens the menu — UNLESS exception 2 below also applies.
// EXCEPTION 2 — approving FROM THE BLOKKEN-INDEX (`keepList`, state.mode was
// 'list', not 'diff'): there's nothing else to choose there either way (no
// diff/drill to jump into, `applyNextUnapproved`'s own `keepList` branch only
// ever moves the sidebar selection) — asking "ga door of niet" is just as
// much friction as exception 1, so a list-mode approve ALWAYS jumps straight
// to the next not-yet-approved block instead of opening the postApprove menu,
// regardless of whether that next block is the same one or a different one.
// `auto` (passed by spaceKey, below) is a THIRD way to skip the postApprove
// confirm menu: unlike exceptions 1/2 it isn't about WHERE the next unit
// lands, it's the reviewer having asked, via Space, to always continue
// without confirming — so the branch that would otherwise stash
// postApproveTarget and open 'postApprove' applies the plan directly instead.
// The "nothing left ahead" branch is deliberately untouched by `auto`: whether
// to submit a real GitHub review (or reject it) stays a manual, two-step
// choice regardless of how the last unit was approved.
// offerReviewSubmitFollowup opens the same review-submit choice both
// afterApproveAction (nothing left to approve ahead) and afterResolveAction
// (nothing left to approve OR to resolve ahead) fall back to — extracted so
// there is exactly one copy of this "is the whole PR done" check instead of
// two menus quietly drifting apart. b.approvedRows/approvedCalls (or a
// comment's status) were just reassigned synchronously by the caller, but
// state.approvalTotal is filled by a DECOUPLED watch (see its comment near
// state.approvalSummaries) whose callback runs as a microtask, not
// synchronously — give it a couple of turns to flush before reading it, same
// as loadBlocks' identical wait for the same watch.
async function offerReviewSubmitFollowup() {
  await Promise.resolve()
  await Promise.resolve()
  const allDone = state.approvalTotal.total > 0 && state.approvalTotal.done === state.approvalTotal.total
  openMenu(allDone ? 'reviewApprove' : 'reviewChoice')
}

function afterApproveAction(approving, blockId, auto = false) {
  if (!approving) return
  const keepList = state.mode !== 'diff'
  return findNextUnapproved().then(async (target) => {
    if (!target) {
      await offerReviewSubmitFollowup()
      return
    }
    // The landing block of the plan — the last entry of target.path, or (an
    // empty path) the top-level block at target.root. Comparing THIS against
    // blockId (the block that was just approved, captured synchronously by
    // the caller before this async gap) is what "stays in the same block"
    // actually means — NOT target.path.length === 0, which only happens to
    // be true at the top level (state.focusLevel === 0). Inside a drilled
    // column (state.focusLevel > 0), findNextUnapproved's own step-1 branch
    // ("forward within the column that currently owns the keyboard") returns
    // target.path = state.drill.slice(0, level) — by the focusLevel ===
    // state.drill.length invariant (see detail-layout.md, "Column
    // navigation"), that's always the SAME, non-empty drill stack, even
    // though nothing but the change/gran cursor moved. A bare
    // path.length === 0 check therefore never fired here, so approving a
    // line with another unapproved line still ahead in the same drilled
    // block wrongly opened the postApprove menu instead of jumping straight
    // there (the reported gap for gedrilde kolommen).
    // A test_class plan's own top-level "block" isn't the row itself (it has
    // no rows of its own) but the ACTIVE METHOD (target.methodIdx) — see
    // testClassRowItem/recomputeLeftList.
    const rootBlock = state.blocks[target.root]
    const landingId = target.path.length
      ? target.path[target.path.length - 1].id
      : target.methodIdx != null
        ? rootBlock && rootBlock.methods[target.methodIdx] && rootBlock.methods[target.methodIdx].id
        : rootBlock && rootBlock.id
    const sameBlock = !keepList && target.root === state.selected && landingId === blockId
    if (sameBlock || keepList || auto) {
      // `applyNextUnapproved` reads `target.keepList` to decide whether to
      // stay in the list (see its own doc comment) — `target` itself never
      // carries that flag, only the stashed `postApproveTarget` normally
      // does, so it must be merged in here too.
      applyNextUnapproved({ ...target, keepList })
      return
    }
    postApproveTarget = { ...target, keepList }
    openMenu('postApprove')
  })
}

// findNextUnresolvedComment — the comment-side counterpart of
// findNextUnapproved's own forward-only, no-wrap contract (see its doc
// comment): walks state.blocks from state.selected + 1 onward for the first
// kind:'comment' row (see commentBlockItem) whose comment GROUP (b.comments,
// see "Comment-index rows are grouped per source line" in
// comments-panel.md) still has at least one comment that isn't resolved yet
// — reusing blockApproveCount's own done/total count rather than a second
// per-comment status check, so this agrees with whatever the sidebar pill
// already shows. Returns the sidebar index, or null if nothing ahead
// qualifies (same "null doesn't mean done" caveat as findNextUnapproved —
// afterResolveAction is the only caller and it only reaches this once
// findNextUnapproved itself already came up empty).
// findNextUnresolvedCommentFrom is the shared scan findNextUnresolvedComment
// (below, the ordinary-code fallback step of afterResolveAction) wraps with
// the current state.selected + 1. afterCommentRowRemoved's callers
// (resolving/deleting FROM the row itself) always pass a snapshot taken
// BEFORE their own write instead: removing state.blocks[beforeIdx] shifts
// every later row up one slot, and recomputeLeftList's own id-preserving
// reindex (see its own doc comment) already reset state.selected to 0 by the
// time the caller's own await resumes — reading state.selected fresh here
// would restart the scan from the wrong place entirely (0, not "just past
// the removed row"). "The next remaining row" is whatever now sits at the
// removed row's OLD index, i.e. beforeIdx itself, so the scan must start
// there (inclusive), not at beforeIdx + 1.
function findNextUnresolvedCommentFrom(startIdx) {
  for (let idx = startIdx; idx < state.blocks.length; idx++) {
    const candidate = state.blocks[idx]
    if (candidate.kind !== 'comment') continue
    const { done, total } = blockApproveCount(candidate)
    if (done < total) return idx
  }
  return null
}

function findNextUnresolvedComment() {
  return findNextUnresolvedCommentFrom(state.selected + 1)
}

// isCommentIndexRowActive — true while the sidebar cursor (state.selected,
// i.e. curBlock()) itself sits on a comment/chat "Start" row (kind:'comment':
// a "Comments op regels" item, a PR-wide comment, an AI finding, or a bare
// Claude-chat anchor) — whether or not its thread/anchor has been
// entered/drilled open. Deliberately curBlock(), not focusedBlock():
// openCommentAnchorDrill never touches state.selected (see
// comments-panel.md's "Only one thing reads as selected at a time"), so a
// resolve/delete reached from INSIDE a drilled "Comments op regels" anchor's
// own thread must still count here — but focusedBlock() there resolves to
// the drilled REAL code block (kind !== 'comment'), not the sidebar item
// that opened it. Gates afterResolveAction/afterCommentRowRemoved's callers
// (reviewer request, 2026-08-27): "ook bij resolve, maar alleen als ik in de
// blokken index bezig ben onder 'Comment onder regels' of comment of chat
// category. als ik gewoon bezig ben met code en daar een comment resolve,
// dan moet je gewoon handelen zoals je normaal doet."
//
// MUST be called (and its result snapshotted) BEFORE the resolve/delete
// write itself, never read fresh afterward — see afterResolveAction's own
// doc comment for why a resolved/deleted row's disappearance from
// state.blocks makes a later read of this unreliable.
function isCommentIndexRowActive() {
  const b = curBlock()
  return !!(b && b.kind === 'comment')
}

// afterCommentRowRemoved is the comment/chat-index counterpart of
// afterResolveAction/afterApproveAction's own "nothing left" fallback, for
// the two actions that can make a blokken-index comment/chat row disappear
// while the reviewer was working FROM that row (isCommentIndexRowActive,
// snapshotted by the CALLER before its own write — see that function's doc
// comment) — resolving it, or deleting it (including "Wis Claude-gesprek"
// clearing a bare chat placeholder, which deletes its own backing comment
// too, see clearClaudeChat's return value in RelatedPanel.mjs). Deliberately
// skips findNextUnapproved's tree walk entirely — reviewer request: "niet
// eerst dieper de tree in naar het volgende niet-goedgekeurde item" — and
// lands directly on the next still-open comment/chat row, falling back to
// the same review-submit offer afterApproveAction/afterResolveAction share.
// `startIdx` is always the CALLER's own state.selected snapshot taken before
// its write (never read fresh in here either — see
// findNextUnresolvedCommentFrom's own doc comment for why). Resolving or
// deleting a comment while just working through ordinary code (not from
// this row) is UNAFFECTED — see each call site's own isCommentIndexRowActive
// gate; afterApproveAction (the ordinary approve flow) never calls this at
// all.
async function afterCommentRowRemoved(startIdx) {
  const idx = findNextUnresolvedCommentFrom(startIdx)
  if (idx != null) {
    state.selected = idx
    scrollSelectedIntoView()
    return
  }
  await offerReviewSubmitFollowup()
}

// afterResolveAction runs once a comment has actually been RESOLVED — the
// shared follow-up for both commentCommandsFor's block-scoped "Resolve
// comment" and prCommentCommandsFor's comment-index "Resolve comment" (never
// after "Unresolve comment"/"Verwijder comment" — those aren't a forward
// step). Reviewer request (2026-08-26): "als ik een comment resolve, ga dan
// naar het volgende wat ik moet approven en anders naar de eerstvolgende
// comment die nog niet resolved is" — confirmed to navigate DIRECTLY, with
// no confirm menu (unlike afterApproveAction's postApprove follow-up, which
// exists because approving is the more consequential action), to apply to
// both entry points, to stay forward-only/no-wrap like findNextUnapproved,
// and not to care who wrote the resolved comment.
//
// Narrowed the next day (2026-08-27): "ook bij resolve, maar alleen als ik
// in de blokken index bezig ben onder 'Comment onder regels' of comment of
// chat category. als ik gewoon bezig ben met code en daar een comment
// resolve, dan moet je gewoon handelen zoals je normaal doet." While the
// sidebar cursor sat on that comment/chat row (wasCommentIndexRow — covers a
// directly-selected comment-index item AND its own drilled "Comments op
// regels" thread once entered), skip straight to afterCommentRowRemoved:
// never dive into findNextUnapproved's tree walk first. Resolving an
// ordinary block-scoped comment while the keyboard is just navigating
// regular code (curBlock() was a real code block, not the comment item)
// keeps the original three-step order below unchanged.
//
// `wasCommentIndexRow`/`beforeIdx` MUST be snapshotted by the caller BEFORE
// its own resolve call (isCommentIndexRowActive()/state.selected at that
// point), never read fresh in here: a resolved BLOCK-ANCHORED comment is
// dropped from indexComments() entirely (see recomputeLeftList's own doc
// comment — it only ever existed in the index because it was unresolved),
// so by the time this function runs the row is already gone from
// state.blocks and state.selected has already been reset to 0 — reading
// either fresh here would silently fall through to the ordinary-code branch
// even when the reviewer really was on that row (reported: resolving from
// an anchored row with its own block still unapproved jumped straight into
// that block's diff instead of the next comment). `beforeIdx` is also the
// correct scan start for the fallback below, for the same reason
// deleteCommentAndSelectRow's own beforeIdx snapshot exists.
// Three-step order for the ordinary-code case, matching the original
// request literally:
//   1. The next unit anywhere in the tree that still needs approving
//      (findNextUnapproved, the exact same walk the approve flow uses) — if
//      found, jump there straight away via applyNextUnapproved.
//   2. Otherwise, the next comment-index row that isn't fully resolved yet
//      (findNextUnresolvedComment above).
//   3. Otherwise (nothing left to approve AND nothing left to resolve ahead)
//      the same review-submit offer afterApproveAction falls back to —
//      offerReviewSubmitFollowup, shared so there's only one copy of it.
// `keepList` mirrors afterApproveAction's own "approving FROM THE
// BLOKKEN-INDEX" exception: resolving while state.mode is still 'list'
// (the ordinary comment-index row's own resting mode) keeps the reviewer in
// the list — applyNextUnapproved's keepList branch only moves state.selected,
// never drills into a diff — instead of unexpectedly dropping them into a
// block's diff/drilled column just because the next unapproved unit happens
// to live inside one.
async function afterResolveAction(wasCommentIndexRow, beforeIdx) {
  if (wasCommentIndexRow) {
    await afterCommentRowRemoved(beforeIdx)
    return
  }
  const keepList = state.mode !== 'diff'
  const target = await findNextUnapproved()
  if (target) {
    applyNextUnapproved({ ...target, keepList })
    return
  }
  const idx = findNextUnresolvedComment()
  if (idx != null) {
    state.selected = idx
    scrollSelectedIntoView()
    return
  }
  await offerReviewSubmitFollowup()
}

// isApproveDone tells whether the unit approveContext() currently resolves to
// is ALREADY fully approved — shared by the COMMANDS 'approve' label (its
// "goedkeuren vs. intrekken" wording) and spaceKey (below), so both agree on
// the same "is there anything left to approve here" answer without a second
// implementation of the check.
function isApproveDone(ctx) {
  const b = ctx.b
  if (b && ctx.mode === 'diff' && ctx.gran === 'call') {
    const unit = navUnitsOf(b, blockRows(b), 'call')[ctx.change]
    // A reference unit is never "open work": there is nothing in it to approve.
    if (unit && unit.ref) return true
    return callUnitApproved(b, unit)
  }
  const set = b ? approvedRowSet(b) : new Set()
  const target = approveTargetRows(ctx)
  return target.length > 0 && target.every((i) => set.has(i))
}

// callSegmentApproved reports whether one call segment of a row already counts
// as approved — either individually (an approvedCalls key) or because the whole
// row graduated into approvedRows (see toggleCallApprove).
function callSegmentApproved(b, row, segStart) {
  return approvedRowSet(b).has(row) || approvedCallSet(b).has(callKey(row, segStart))
}

// firstUnapprovedCallSiteInUnit finds, within the rows a navigation unit
// covers, the FIRST call site (in reading order: row, then segment) that
// (a) resolves to a PR block of its own, (b) still has something unapproved
// somewhere in its subtree, and (c) whose own segment isn't approved yet.
// Returns { row, segStart, kid, found } — `found` being firstUnapprovedInSubtree's
// landing plan relative to `kid` — or null when the unit has no such call.
//
// (c) is what keeps this from ping-ponging: a reviewer who drills in, decides
// NOT to approve the child and comes back would otherwise be sent straight
// back down by the next Space. Once the call itself is approved this site is
// simply passed over.
// Deliberately only resolved METHOD CALLS (callRows): "de call waar dat
// onderliggende blok aan gekoppeld is" has to name a real segment in this
// line, which a relation child (a line anchor without a segment) and a
// block-level synthetic call key (resource:/migration_model:/…, no literal
// site at all — see findCallSites) don't have.
//
// At CALL granularity `unit` names one exact segment of its row
// (`unit.segStart`, the same discriminator changeCalls/referenceUnit set —
// see callScopeMethods, which applies the identical rule for the panel's own
// scoping), and a site only counts when it sits in that SAME segment
// (`site.segStart === unit.segStart`), not merely somewhere on the same row.
// A row can hold several call-chain segments (`$this->calc->arrowHelper(2)`
// splits into `$this` / `->calc` / `->arrowHelper(` / `2);`), so without this
// check Space on a segment that has no call of its own (e.g. `$this` or a
// bare argument) could still "find" and descend into a DIFFERENT call's
// unapproved subtree elsewhere on the row — the call selection didn't
// actually cover that call yet. At `group`/`line` granularity `unit` has no
// `segStart` and the row-range check below is the whole story, unchanged:
// there every call anywhere in the wider unit is fair game.
async function firstUnapprovedCallSiteInUnit(b, unit) {
  const rows = blockRows(b)
  const byId = allBlocksById()
  const sites = []
  const callGran = typeof unit.segStart === 'number'
  for (const r of callRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    const kid = byId.get(callChildId(r))
    if (!kid || kid.id === b.id) continue
    for (const site of findCallSites(rows, r.callKey)) {
      if (site.row < unit.start || site.row > unit.end) continue
      if (callGran && site.segStart !== unit.segStart) continue
      if (callSegmentApproved(b, site.row, site.segStart)) continue
      sites.push({ row: site.row, segStart: site.segStart, kid })
    }
  }
  sites.sort((x, y) => x.row - y.row || x.segStart - y.segStart)
  // One subtree walk per child, however many sites it has in this unit.
  const walked = new Map()
  for (const s of sites) {
    if (!walked.has(s.kid.id)) walked.set(s.kid.id, await firstUnapprovedInSubtree(s.kid))
    const found = walked.get(s.kid.id)
    if (found) return { ...s, found }
  }
  return null
}

// approveThroughCall approves everything in `unit` up to AND INCLUDING the call
// segment at (siteRow, siteSegStart), leaving the rest of the unit alone: every
// changed row of the unit before siteRow in full, plus the segments of siteRow
// itself that start at or before that call. Same bookkeeping as
// toggleCallApprove — a row whose every segment ends up approved graduates into
// approvedRows and drops its approvedCalls keys; both arrays are reassigned
// wholesale so arrow.js repaints — and persisted through the same `set` Signal.
function approveThroughCall(b, unit, siteRow, siteSegStart) {
  const rows = blockRows(b)
  const rowSet = approvedRowSet(b)
  const callSet = approvedCallSet(b)
  for (const i of changedRows(rows)) {
    if (i >= unit.start && i < siteRow) rowSet.add(i)
  }
  const segs = rowCallSegments(rows, siteRow)
  const keys = new Set(
    rowSet.has(siteRow)
      ? segs.map((sg) => callKey(siteRow, sg.start))
      : [...callSet].filter((k) => k.startsWith(siteRow + ':')),
  )
  for (const sg of segs) if (sg.start <= siteSegStart) keys.add(callKey(siteRow, sg.start))
  const others = [...callSet].filter((k) => !k.startsWith(siteRow + ':'))
  if (keys.size === segs.length) {
    rowSet.add(siteRow)
    b.approvedCalls = others
  } else {
    rowSet.delete(siteRow)
    b.approvedCalls = [...others, ...keys]
  }
  b.approvedRows = [...rowSet].sort((x, y) => x - y)
  persistApproval(b)
}

// descendIntoUnapprovedCall is Space's "don't approve past unread code" step
// (reviewer request: "als ik spatie druk op een selectie, en die selectie heeft
// nog onderliggende blokken (ook dieper) die nog niet zijn goedgekeurd, ga daar
// dan naartoe, keur dan alleen de call goed waar die onderliggende blok aan
// gekoppeld is (en alle calls daarvoor)"). Approving a whole group in one press
// would otherwise silently tick off call sites whose underlying code the
// reviewer never opened.
//
// It approves the unit only UP TO AND INCLUDING that call (approveThroughCall)
// and then drills to the child's own first unapproved unit, so the rest of the
// group stays for the next Space once the reviewer comes back up. Returns true
// when it handled the keypress; false means "nothing underneath, approve
// normally".
//
// Only in diff mode (a list-mode approve covers the whole block and has no
// cursor unit to split at) and never for a TRANSLATION block (its per-key units
// have no call segments). Deliberately NO afterApproveAction here: the landing
// spot is already decided, so running the whole findNextUnapproved chain again
// would only fight it.
async function descendIntoUnapprovedCall(ctx) {
  const b = ctx.b
  if (!b || ctx.mode !== 'diff' || b.category === 'TRANSLATION') return false
  const rows = blockRows(b)
  const units = navUnitsOf(b, rows, ctx.gran)
  const unit = isRangeGran(ctx.gran) ? rangeUnit(units, ctx.change, ctx.anchor) : units[ctx.change]
  if (!unit) return false
  const site = await firstUnapprovedCallSiteInUnit(b, unit)
  if (!site) return false
  approveThroughCall(b, unit, site.row, site.segStart)
  const level = state.focusLevel
  applyNextUnapproved({
    root: state.selected,
    path: [...state.drill.slice(0, level), site.kid, ...site.found.path],
    gran: site.found.gran,
    change: site.found.change,
  })
  return true
}

// spaceKey — Space is a one-key shortcut for exactly what the block palette's
// "Keur ... goed" already does, immediately followed by "Ga door": it reuses
// toggleApprove/toggleCallApprove (via approveContext, same as the palette
// item) with `auto = true`, which makes afterApproveAction apply the next-
// unapproved plan directly instead of stashing it for a postApprove confirm
// (see afterApproveAction's own `auto` doc comment) — so approving and
// continuing happen in one keypress, no menu ever flashes on screen.
// If the unit under the keyboard is ALREADY approved (isApproveDone), there is
// nothing to approve here — Space then behaves purely as "Ga door" would:
// jump to the next unapproved unit via the same findNextUnapproved/
// applyNextUnapproved pair the postApprove menu itself uses, with no toggle.
// `keepList` is captured HERE, synchronously, exactly like afterApproveAction
// does (state.mode can't have changed yet) — without it, applyNextUnapproved's
// non-keepList path unconditionally sets state.mode = 'diff', so pressing
// Space on an already-done unit while still in the block/methodes-kolom LIST
// would silently force the diff open instead of just moving the cursor.
// If nothing is left ahead either, this mirrors afterApproveAction's own
// "nothing left ahead" branch (the same two microtask ticks to let the
// decoupled state.approvalTotal watch flush) and opens the same
// reviewApprove/reviewChoice review-submit menu — approving/rejecting the
// whole PR stays a manual, two-step choice, never automatic.
function spaceKey() {
  // A Shift+arrow multi-row selection in the index/methodes-kolom takes
  // precedence: Space then approves (or clears) the WHOLE selection in one
  // press, exactly what the palette's own range item does — no second
  // implementation. Bulk, so no "ga door" follow-up (see toggleRangeApproval).
  if (hasMultiSelection()) {
    toggleRangeApproval()
    return
  }
  // A comment index row: Space used to RESOLVE the comment outright — one
  // keypress, no confirm — which turned out to be too easy to trigger by
  // accident once the row also carries a comment_batch checkbox (reviewer
  // report: "ik wil niet comments kunnen resolven met een spatiebalk in de
  // blokken index, dat gaat te snel"). Resolving now only happens through the
  // row's own Enter menu ("Resolve comment", already the default item for
  // the reviewer's own comment — see prCommentCommandsFor). Space here
  // instead TOGGLES the row's own batch-selection checkbox
  // (toggleBatchChecked, mirrors clicking it — see batchCheckbox,
  // BlockList.mjs) when it has one, or — when it doesn't (an AI finding, or
  // an ignored-and-revealed comment, neither of which comment_batch may ever
  // touch — isBatchEligible/isIgnoredComment) — advances to the next row,
  // mirroring the existing "↓ falls through" convention elsewhere in this
  // file rather than doing nothing.
  const curB = curBlock()
  if (curB && curB.kind === 'comment') {
    if (isBatchEligible(curB.comment) && !isIgnoredComment(state, curB)) {
      toggleBatchChecked(state, curB.comment.id)
    } else {
      stepListSelection(1)
      scrollSelectedIntoView()
    }
    return
  }
  const ctx = approveContext()
  if (!ctx.b) return
  if (!isApproveDone(ctx)) {
    // Before approving the unit, check whether it calls into code that itself
    // still has unapproved work — then approve only up to that call and go
    // there instead (see descendIntoUnapprovedCall).
    descendIntoUnapprovedCall(ctx).then((handled) => {
      if (!handled) toggleApprove(true)
    })
    return
  }
  const keepList = state.mode !== 'diff'
  findNextUnapproved().then(async (target) => {
    if (target) {
      applyNextUnapproved({ ...target, keepList })
      return
    }
    await Promise.resolve()
    await Promise.resolve()
    const allDone = state.approvalTotal.total > 0 && state.approvalTotal.done === state.approvalTotal.total
    openMenu(allDone ? 'reviewApprove' : 'reviewChoice')
  })
}

// "Sluit menu" is pinned first (withClose); the menu opens on the 2nd item
// (defaultSel), so "Keur ... goed" stays the default Enter action.
const COMMANDS = withClose([
  {
    id: 'approve',
    label: () => {
      const ctx = approveContext()
      const noun = approveNoun(ctx)
      return isApproveDone(ctx) ? t('Trek goedkeuring van {noun} in', { noun }) : t('Keur {noun} goed', { noun })
    },
    hint: 'approve',
    run: () => toggleApprove(),
  },
  {
    id: 'comment',
    label: t('Comment op deze regel'),
    hint: 'task',
    run: () => startComment(commentTarget),
  },
  {
    id: 'claude-chat',
    // Reviewer request: chat with Claude about this line right away, with no
    // comment written/placed first — startClaudeChat (RelatedPanel.mjs)
    // opens the same brand-new composer state as "Comment op deze regel" and
    // immediately steps the keyboard into the Claude composer, exactly as if
    // → had been pressed from that still-open field.
    label: t('Chat over deze regel'),
    hint: 'claude',
    run: () => startClaudeChat(commentTarget),
  },
  {
    id: 'copy-line',
    // Reviewer request: copy the currently focused unit's code, without its
    // shared leading indentation (dedentCode) — same clipboard mechanism as
    // the native right-click menu's "Kopieer selectie", just for the current
    // navigation unit instead of a dragged text selection.
    label: t('Kopieer deze regel'),
    hint: 'copy kopieer',
    run: () => copySelectedCode(),
  },
  {
    id: 'github',
    label: t('Open GitHub'),
    hint: 'github',
    // A parent command: choosing it opens a submenu of the two targets rather
    // than acting directly (see runCommand). "Sluit menu" is pinned first
    // there too (withClose), same as every other submenu.
    children: withClose([
      {
        id: 'github-line',
        label: t('Regel in Files changed'),
        hint: 'github',
        run: () => openGithubLine(),
      },
      {
        id: 'github-pr',
        label: t('PR-pagina'),
        hint: 'github',
        run: () => window.open(state.prUrl || GITHUB_PR, '_blank'),
      },
    ]),
  },
])

// PR_COMMANDS — the general, PR-wide tree menu opened with `/` (menu mode 'pr').
// Unlike COMMANDS (which acts on the selected block/diff), these are actions on
// the whole PR: GitHub/Jira with their own submenus, the code_warning risk
// check, and the description toggle. The Jira comment + subtask items are
// placeholders for now (no Jira write integration yet). GitHub "comment
// plaatsen" reuses the line-comment composer (startComment), same as the
// block menu. See the `/` handler in onKeydown. "Sluit menu" is pinned first
// (withClose); the menu opens on the 2nd item (defaultSel), so "GitHub" stays
// the default Enter action (which opens its own submenu rather than running
// an action directly — deliberate, see the "Naar PR-overzicht" removal note
// in git history: no reordering to keep a direct-action default).
// A separate "Naar PR-overzicht" item used to sit here (jumping straight to
// /pr-overview via overviewExitUrl); it was removed since the ← nav-chain
// exit (stop 1, state.showDescription) already reaches the same destination
// with the same params — see overviewExitUrl above.
// openGeneralChat — the ONE entry point into this PR's general conversation,
// shared by the PR menu's own item, its no-match fallback and the `→` on the
// "Openstaande chats" row. Shows the overlay FIRST (so the reviewer sees
// something the same frame, even while the very first anchor comment is still
// being created) and then lets RelatedPanel create/reuse the anchor, load the
// conversation and focus its composer. `text`, when given, is sent straight
// away as the first turn.
function openGeneralChat(text) {
  openGeneralChatOverlay()
  startPrGeneralChat(state, text)
}

const PR_COMMANDS = withClose([
  {
    id: 'pr-general-chat',
    // The general (PR-wide, code-less) chat — startPrGeneralChat creates or
    // reuses this PR's ONE general conversation and shows it in the overlay
    // (generalChatOverlay.mjs). Deliberately the FIRST real item, i.e.
    // defaultSel's default Enter action: `/` is now always this menu
    // (see onKeydown's `/` branch) and the reviewer's own reason for that
    // was "als ik `/` typ, wil ik chatten met claude".
    label: t('Chat met Claude over deze PR'),
    hint: 'claude',
    run: () => openGeneralChat(),
  },
  {
    id: 'pr-github',
    label: t('GitHub'),
    hint: 'github',
    children: withClose([
      {
        id: 'pr-github-open',
        label: t('Open op GitHub'),
        hint: 'github',
        run: () => window.open(state.prUrl || GITHUB_PR, '_blank'),
      },
      {
        id: 'pr-github-review',
        // Manual entry point into the exact same approve/reject flow as the
        // automatic postApprove follow-up (see REVIEW_CHOICE_COMMANDS above) —
        // reachable at any time, not only after approving the last unit.
        label: t('PR keuren'),
        hint: 'review',
        icon: 'approve-pr',
        children: REVIEW_CHOICE_COMMANDS,
      },
      {
        id: 'pr-github-comment',
        // "Algemene", not just "Comment plaatsen": this is the PR-WIDE
        // comment (a GitHub issue comment on the PR conversation), which the
        // block palette's own "Comment op deze regel" is not. It used to run
        // startComment — the line-comment composer — which meant this item
        // either placed an ordinary line comment or (with a PR-comment index
        // row selected) did nothing at all. See startPrWideComment.
        label: t('Algemene comment plaatsen'),
        hint: 'comment',
        run: () => startPrWideComment(),
      },
    ]),
  },
  {
    id: 'pr-jira',
    label: t('Jira'),
    hint: 'jira',
    children: withClose([
      {
        id: 'pr-jira-open',
        // Label names the ticket once we know it (title carried a KEY-123).
        label: () => (state.jiraKey ? t('Openen in nieuw tab ({key})', { key: state.jiraKey }) : t('Openen in nieuw tab')),
        hint: 'jira',
        run: () => window.open(state.jiraKey ? JIRA_BASE + state.jiraKey : JIRA_BASE, '_blank'),
      },
      {
        id: 'pr-jira-comment',
        label: t('Comment plaatsen'),
        hint: 'todo',
        // Placeholder — no Jira write integration yet (see CLAUDE.md).
        run: () => {},
      },
      {
        id: 'pr-jira-subtask',
        label: t('Subtask maken'),
        hint: 'todo',
        // Placeholder — no Jira subtask creation yet.
        run: () => {},
      },
    ]),
  },
  {
    id: 'pr-toggle-description',
    // Label is a function so it names the current action; snapshotCommands reads
    // it once (non-reactively) at open, so it never leaks a reactive binding into
    // the CommandMenu tree (see the label-function note in conventions.md).
    label: () => (state.descriptionExpanded ? t('Omschrijving inklappen') : t('Toon volledige omschrijving')),
    hint: 'omschrijving',
    run: () => {
      state.descriptionExpanded = !state.descriptionExpanded
    },
  },
  {
    id: 'pr-test-run',
    // "Tests laten draaien" (test_run.go): Claude itself decides which
    // existing tests are relevant to this PR and runs only those — no
    // selection step here, unlike "Comments laten verwerken" (batchActionRow)
    // which needs the reviewer's confirmed comment ids first. Deliberately a
    // `/`-menu item, not its own bottom action row (reviewer decision: the
    // sidebar is busy enough) — progress renders in prInfoCard's status
    // block instead (testRunStatusBlock, testRun.mjs). No confirm step, same
    // reasoning as the batch action row: nothing here can change code (no
    // Edit tool at all), so there's nothing destructive to confirm.
    label: () => (testRun.running ? t('Testrun loopt al…') : t('Tests laten draaien')),
    hint: 'test',
    run: () => {
      if (!testRun.running) startTestRun(state.pr)
    },
  },
  {
    id: 'pr-approve-all',
    // Bulk submenu for the whole-PR approval actions (reviewer request:
    // "Alles keuren" met daarna "Alle code aanpassingen goedkeuren" en
    // "Alle goedkeuringen intrekken", later joined by the combined
    // approve+warnings variant). Groups approveAllForPr,
    // approveAllForPr+deleteAllAiWarnings and retractAllApprovalsForPr under
    // one parent instead of competing top-level PR_COMMANDS entries. Opening this submenu is itself the
    // "one extra Enter" confirm step every other destructive PR-wide action
    // gets via `children` (e.g. "PR keuren"), so neither child needs a
    // further nested "Ja, ..." confirm row.
    label: t('Alles keuren'),
    hint: 'keuren',
    children: withClose([
      {
        id: 'pr-approve-all-rows',
        label: t('Alle code aanpassingen goedkeuren'),
        hint: 'keuren',
        run: () => approveAllForPr(),
      },
      {
        id: 'pr-approve-all-rows-and-warnings',
        // The same bulk approve, plus throwing every code_warning finding
        // away (deleteAllAiWarnings, RelatedPanel.mjs) — reviewer request
        // "ik wil ook een optie daarbij om ook alle warnings weg te halen".
        // A SEPARATE item rather than folding the deletes into the plain
        // "Alle code aanpassingen goedkeuren" above: deleting a finding
        // dismisses it permanently (recordWarningDismissed, see
        // deleteAllAiWarnings' own doc comment), so approving without
        // touching the warnings has to stay available. Sequential await, so
        // the warnings only go once every approval Signal is out.
        label: t('Alle code aanpassingen goedkeuren + warnings weghalen'),
        hint: 'keuren',
        run: async () => {
          await approveAllForPr()
          await deleteAllAiWarnings()
        },
      },
      {
        id: 'pr-retract-all-approvals',
        label: t('Alle goedkeuringen intrekken'),
        hint: 'intrekken',
        run: () => retractAllApprovalsForPr(),
      },
    ]),
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
  const unit = navUnitsOf(b, rows, gran)[idx]
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
  if (mode === 'comment') return commentCommandsFor()
  if (mode === 'claude') return claudeChatCommandsFor()
  if (mode === 'checkout') return checkoutChipCommandsFor()
  if (mode === 'prComment') return prCommentCommandsFor()
  if (mode === 'pushTodo') return pushTodoCommandsFor()
  if (mode === 'task') return taskCommandsFor()
  if (mode === 'replyPublish') return replyPublishCommandsFor()
  if (mode === 'postApprove') return POSTAPPROVE_COMMANDS
  if (mode === 'reviewApprove') return REVIEW_APPROVE_COMMANDS
  if (mode === 'reviewChoice') return REVIEW_CHOICE_COMMANDS
  // reviewReject has no static list — resolveCommands builds its one command
  // straight from the typed reason (see there); nothing to snapshot up front.
  if (mode === 'reviewReject') return []
  if (mode === 'pr') return PR_COMMANDS
  if (mode === 'compose') return COMPOSE_COMMANDS
  return blockCommands()
}

// blockCommands is COMMANDS, minus the approve item while the cursor sits on a
// reference unit (an unchanged line that only carries a call — see
// referenceRows): there is nothing there to approve, so offering "Keur deze
// regel goed" would be a dead row. Everything else (comment, chat, GitHub)
// applies to such a line exactly as it does to a changed one. The pinned
// "Sluit menu" stays index 0, so defaultSel keeps opening on the 2nd row.
function blockCommands() {
  // A Shift+arrow multi-row selection has its own, much smaller list: the
  // block palette's items all speak about ONE line/block ("Comment op deze
  // regel", "Open GitHub"), which a selection of several rows has no single
  // answer for. See rangeCommandsFor.
  if (hasMultiSelection()) return rangeCommandsFor()
  return activeUnitIsReference() ? COMMANDS.filter((c) => c.id !== 'approve') : COMMANDS
}

// selectionNoun names what a multi-row selection covers, for the labels: N
// methods inside the methodes-kolom, N blocks in the index.
function selectionNoun() {
  if (isTestColumnActive())
    return t('deze {n} methodes', { n: methodRangeIndices(curTestClassRow()).length })
  return t('deze {n} blokken', { n: listRangeIndices().length })
}

// selectionApproveDone reports whether EVERY row of the current multi-row
// selection is already fully approved — the same done/total check the sidebar
// pill shows (approvalSummaries via blockApproveCount), so the label and the
// action agree on which way the toggle goes.
function selectionApproveDone() {
  const blocks = isTestColumnActive()
    ? methodRangeIndices(curTestClassRow()).map((i) => curTestClassRow().methods[i])
    : listRangeIndices()
        .map((i) => state.blocks[i])
        .filter((b) => b && b.kind !== 'comment')
  if (!blocks.length) return false
  return blocks.every((b) => {
    const c = blockApproveCount(b)
    return c.total > 0 && c.done === c.total
  })
}

// rangeBlocks returns the actual block/method objects an active Shift+arrow
// multi-selection covers, in list order — the index/methodes-kolom twin of
// selectionApproveDone's own local computation, extracted so
// rangeIgnorableComments/startRangeComment/startRangeChat below can share it.
// Deliberately unfiltered (unlike selectionApproveDone's `b.kind !== 'comment'`
// filter): each caller decides for itself what it does with a comment item.
function rangeBlocks() {
  if (isTestColumnActive()) {
    const row = curTestClassRow()
    return methodRangeIndices(row).map((i) => row.methods[i])
  }
  return listRangeIndices()
    .map((i) => state.blocks[i])
    .filter(Boolean)
}

// rangeIgnorableComments is the subset of rangeBlocks() that can actually be
// ignored — a PR-comment index item (kind:'comment'), the only kind of row
// the existing single-item "Ignore" action (toggleIgnoreComment,
// prCommentCommandsFor) applies to. An ordinary block/test method has no
// ignore concept of its own (yet), so it's simply skipped here — the same
// split toggleRangeApproval already makes in the opposite direction (a
// comment item is skipped there because "approved" means "resolved", a real
// GitHub-side action a bulk key must not trigger).
function rangeIgnorableComments() {
  return rangeBlocks().filter((b) => b.kind === 'comment')
}

// rangeIgnoreDone reports whether every ignorable item in the selection is
// already ignored — mirrors selectionApproveDone's "does the label say
// ignore or un-ignore" role.
function rangeIgnoreDone() {
  const items = rangeIgnorableComments()
  return items.length > 0 && items.every((b) => isIgnoredComment(state, b))
}

// toggleRangeIgnore flips every ignorable item in the selection to one
// shared target state (ignore everything not yet ignored, or clear
// everything once it's already all ignored — same toggle shape as
// toggleRangeApproval). Reuses the existing single-item toggleIgnoreComment
// per row rather than a second implementation, so each item still signals
// through the exact same per-comment `ignore_comment` Signal — one Signal
// per comment, never a batch write.
function toggleRangeIgnore() {
  const items = rangeIgnorableComments()
  if (!items.length) return
  const target = !rangeIgnoreDone()
  for (const b of items) {
    if (isIgnoredComment(state, b) !== target) toggleIgnoreComment(b.comment)
  }
}

// rangeChatEligible gates "Plaats comment over dit bereik"/"Chat met Claude
// over dit bereik": both anchor on the CURSOR's own block/method (see
// startRangeComment/startRangeChat's own doc comment for why not the
// selection's literal first item), so neither has anywhere to anchor when the
// cursor itself sits on a PR-comment index row — the same reason COMMANDS
// itself never opens there (selectedComment() routes Enter to
// prCommentCommandsFor instead, see command-palette.md).
function rangeChatEligible() {
  const b = curBlock()
  return !!b && b.kind !== 'comment'
}

// rangeCommandsFor is the palette for an active Shift+arrow multi-row
// selection. Behind the usual pinned "Sluit menu" (defaultSel opens on
// "range-approve", unchanged): approve/retract the whole selection, place a
// comment or start a Claude chat anchored on the cursor's own block/method
// but describing the WHOLE selection (see the two start* functions and
// claudeRangeContextBlock in RelatedPanel.mjs), and — only when the selection
// actually contains at least one ignorable PR-comment row — ignore/un-ignore
// those.
function rangeCommandsFor() {
  const items = [
    {
      id: 'range-approve',
      label: () =>
        selectionApproveDone()
          ? t('Trek goedkeuring van {noun} in', { noun: selectionNoun() })
          : t('Keur {noun} goed', { noun: selectionNoun() }),
      hint: 'approve',
      run: () => toggleRangeApproval(),
    },
  ]
  if (rangeChatEligible()) {
    items.push(
      {
        id: 'range-comment',
        label: () => t('Plaats comment over {noun}', { noun: selectionNoun() }),
        hint: 'task',
        run: () => startRangeComment(commentTarget, rangeBlocks()),
      },
      {
        id: 'range-claude',
        label: () => t('Chat met Claude over {noun}', { noun: selectionNoun() }),
        hint: 'claude',
        run: () => startRangeChat(commentTarget, rangeBlocks()),
      },
    )
  }
  if (rangeIgnorableComments().length) {
    items.push({
      id: 'range-ignore',
      label: () =>
        rangeIgnoreDone()
          ? t('Ignore ongedaan maken voor {n} comments', { n: rangeIgnorableComments().length })
          : t('Ignore {n} comments in dit bereik', { n: rangeIgnorableComments().length }),
      hint: 'ignore',
      run: () => toggleRangeIgnore(),
    })
  }
  return withClose(items)
}

// resolveCommands returns the commands to show for `query`: the fuzzy-matched
// `ms.commands` (a plain-string-label snapshot of the current mode's root list,
// built by openMenu/rootCommandsFor+snapshotCommands), or — when nothing
// matches a non-empty query in the default 'block' mode — a two-item fallback
// that opens either the Claude composer or the comment composer with the
// typed text pre-filled, so the reviewer can continue typing ("Chat over deze
// regel", default, and "Comment op deze regel" below it). Shared by the menu
// render (CommandMenu's own `resolve` prop) and the keyboard handler so both
// walk the exact same list — which is why the `native` (right-click) filter
// below lives HERE, in the one shared function, rather than separately in
// CommandMenu.mjs's render and in onKeydown's ↑/↓/Enter handling: those two
// consumers indexing into two subtly different lists is exactly the bug this
// avoids (see the comment on this wrapper's own definition below).
function resolveCommands(query) {
  const list = resolveCommandsInner(query)
  // A native (right-click) context menu never shows the pinned "Sluit menu"
  // row at all (reviewer: "niet nodig als ik met rechtermuisknop open doe" —
  // Esc/an outside click already close it) — filtered here, the single
  // shared source, so CommandMenu's render and onKeydown's ms.sel bounds
  // always agree on the same indices. A no-op for a mode/step whose list
  // never had one in the first place (e.g. reviewReject's dynamic list).
  return ms.native ? list.filter((c) => c.id !== 'close-menu') : list
}

function resolveCommandsInner(query) {
  // A submenu (ms.sub, set by enterSubmenu when a command has `children` —
  // e.g. "Open GitHub", or REVIEW_APPROVE_CONFIRM_COMMANDS opened from
  // "Keur de HELE PR goed" below) always wins, regardless of ms.mode: mode
  // itself doesn't change while a submenu is open (it only ever describes the
  // ROOT list), so this must be checked before any mode-specific early return
  // below — otherwise a mode whose root list contains a `children` command
  // (like reviewApprove/reviewChoice, once REVIEW_APPROVE_CONFIRM_COMMANDS was
  // added) would keep re-showing its own root list instead of the submenu.
  if (ms.sub) return filterCommands(ms.sub, query)
  // The comment-scoped menu (Enter on a focused comment row) is just its own
  // small list — no submenu, no make-a-comment fallback.
  if (ms.mode === 'comment') return filterCommands(ms.commands, query)
  // The Claude-column menu (Enter on the claude focus, stepped up OR an empty
  // composer — see isClaudeChatFocused/claudeChatCommandsFor below): same
  // shape, just its own small list (one command behind its own confirm
  // submenu, one more conditional on claudeAnchorIsPlaceholder()).
  if (ms.mode === 'claude') return filterCommands(ms.commands, query)
  // The checkout-chip menu (Enter/click on the chip in prInfoCard — see
  // checkoutChipCommandsFor): same shape, its own small dynamic list, no
  // typed-query filtering needed for 2-4 fixed rows, but filterCommands is
  // harmless to run regardless (an empty query matches everything).
  if (ms.mode === 'checkout') return filterCommands(ms.commands, query)
  // The comment-INDEX-item menu (Enter on a selected comment row in the
  // sidebar — see selectedComment/prCommentCommandsFor): the fixed action list
  // (Beantwoorden/Resolve/Verwijder/Chat met Claude/...), PLUS its own
  // no-match fallback mirroring the block-mode one below — reported bug: an
  // AI-risicowaarschuwing row selected, Enter, typing an actual question
  // ("Klopt dit echt? geef code voorbeelden") fuzzy-matched none of those
  // short labels and collapsed to CommandMenu's bare "Geen commando's.", a
  // dead end (→ into the thread and using the reply field directly still
  // worked, since that field isn't filtered by the palette at all — which is
  // what made this easy to miss). Can't reuse the block-mode fallback
  // verbatim: it anchors on commentTarget/startComment/startClaudeChat, which
  // assume a real diff unit — a comment-index item has neither (see
  // commentTarget's own null-for-comment-item guard), so this fallback
  // targets the item's own composer entry points instead.
  if (ms.mode === 'prComment') {
    const list = filterCommands(ms.commands, query)
    const q = (query || '').trim()
    if (list.length === 0 && q) {
      return [
        {
          id: 'make-pr-comment-claude-chat',
          label: t('Chat over deze comment'),
          hint: 'claude',
          run: () => {
            startPrCommentChat(selectedComment())
            requestAnimationFrame(() => {
              const el = document.querySelector('[data-testid=claude-chat-compose]')
              if (el) {
                el.value = q
                el.focus()
              }
            })
          },
        },
        {
          id: 'make-pr-comment-reply',
          label: t('Beantwoorden met deze tekst'),
          hint: 'reply',
          run: () => {
            startPrCommentReply(selectedComment())
            requestAnimationFrame(() => {
              const el = document.querySelector('[data-testid=comment-detail-reply]')
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
  // The push-todo row's menu (Enter on the bottom-most index stop — see
  // pushTodoCommandsFor): one command behind its own confirm submenu.
  if (ms.mode === 'pushTodo') return filterCommands(ms.commands, query)
  // The publish follow-up (opened by a send on a still-local thread — see
  // replyPublishCommandsFor): a plain list whose GitHub items may carry
  // `children`, handled by the ms.sub check at the top of this function.
  if (ms.mode === 'replyPublish') return filterCommands(ms.commands, query)
  // The postApprove follow-up (opened right after an approve action finds a
  // next not-yet-approved unit ahead): just its two choices, no submenu, no
  // make-a-comment fallback.
  if (ms.mode === 'postApprove') return filterCommands(ms.commands, query)
  // The two review-submit follow-ups (opened right after an approve action
  // finds NOTHING left ahead — see afterApproveAction): a plain list, no
  // make-a-comment fallback — but "Keur de HELE PR goed" DOES carry
  // `children` (REVIEW_APPROVE_CONFIRM_COMMANDS, the one-more-step confirm),
  // handled by the ms.sub check above, not here.
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
        label: t('Wijs de PR af met deze reden'),
        hint: 'verstuur',
        run: () => submitReview('REQUEST_CHANGES', reason),
      },
    ]
  }
  // (ms.sub itself is handled once, at the top of this function.)
  // The PR-wide tree menu — now what `/` ALWAYS opens (see onKeydown's `/`
  // branch). Its own no-match fallback mirrors the block palette's below:
  // typing a question no PR command matches ("fix tests in pr", the reported
  // case) used to collapse to CommandMenu's bare "Geen commando's.", a dead
  // end. It now becomes the general chat, with the typed text SENT straight
  // away as the conversation's first turn — exactly what "Chat over deze
  // regel" does for a code line (reviewer: direct versturen). Only one item:
  // a PR-wide comment ("Algemene comment plaatsen") is a real, GitHub-visible
  // action and stays a deliberate menu choice, never a fallback.
  if (ms.mode === 'pr') {
    const list = filterCommands(ms.commands, query)
    const q = (query || '').trim()
    if (list.length === 0 && q) {
      return [
        {
          id: 'make-general-chat',
          label: t('Chat over deze PR'),
          hint: 'claude',
          run: () => openGeneralChat(q),
        },
      ]
    }
    return list
  }
  // The comment-kind menu (Enter/button on a filled composer): choose Claude /
  // Git / private / Jira. The ms.sub check above already handles its Jira
  // submenu, so we only reach here at the root list.
  if (ms.mode === 'compose') return filterCommands(ms.commands, query)
  const list = filterCommands(ms.commands, query)
  const q = (query || '').trim()
  if (list.length === 0 && q) {
    // "Chat over deze regel" is FIRST, and therefore the default Enter action —
    // this fallback is a plain array, not run through withClose/defaultSel, so
    // index 0 IS the default here (and CommandMenu's own @input resets ms.sel
    // to 0 on every keystroke). Reviewer request: typing something the palette
    // doesn't know is far more often the start of a question for Claude than
    // the start of a comment, so chatting is the default and "Comment op deze
    // regel" sits right below it. Deliberately still only on NO match — with
    // matches present the palette's own commands keep the field.
    // "Comment op deze regel" only PREFILLS its composer (comment-compose) —
    // placing a comment is a real GitHub-visible action, so it stays a
    // deliberate second step. "Chat over deze regel" is different: reviewer
    // request — typed text there should SEND immediately as the
    // conversation's first turn (sendClaudeChatText, reusing the composer's
    // own send path), not just sit prefilled waiting for a second Enter.
    return [
      {
        id: 'make-claude-chat',
        label: t('Chat over deze regel'),
        hint: 'claude',
        run: () => {
          startClaudeChat(commentTarget)
          // requestAnimationFrame: ensureClaudeAnchorForNew (RelatedPanel.mjs)
          // reads the just-mounted comment-compose textarea, so wait one
          // frame for it, same as every other post-navigation DOM read here.
          requestAnimationFrame(() => {
            sendClaudeChatText(state, commentTarget, q)
          })
        },
      },
      {
        id: 'make-comment',
        label: t('Comment op deze regel'),
        hint: 'comment',
        run: () => {
          startComment(commentTarget)
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
// resizes or scrolls beneath it. A no-op while the menu is fully closed. A
// `native` (right-click) menu has no persistent anchor element to re-measure
// — it's pinned to the exact point the reviewer right-clicked — so a scroll
// or resize just closes it instead, mirroring how a real native OS context
// menu also disappears the moment the page under it moves.
//
// `nativeMenuOpenedAt` guards against the menu's OWN opening gesture closing
// itself: a right-click on a not-yet-selected diff row (handleRowContextMenu)
// first resolves the click into a selection (resolveClickSelection ->
// ensureTopLevelDiffFocus), which can itself trigger a scroll
// (scrollFocusIntoView/scrollChangeIntoView, e.g. because the row's own card
// changed WIDTH once selected — its width is content-driven now, see
// contentWidthCls/Block.mjs — and no longer necessarily matches the
// unselected preview's width) — that scroll's own event can land a frame
// AFTER openMenu already flipped menu.open=true, which this listener would
// otherwise read as "the page moved under an already-open menu" and close it
// immediately, even though the reviewer never got to see it at all. A short
// grace window (comfortably longer than one requestAnimationFrame) treats a
// scroll that lands right after opening as part of the SAME gesture, not an
// unrelated later scroll.
const NATIVE_MENU_SCROLL_GRACE_MS = 150
let nativeMenuOpenedAt = 0
function repositionMenu() {
  if (!menu.open) return
  if (ms.native) {
    if (Date.now() - nativeMenuOpenedAt < NATIVE_MENU_SCROLL_GRACE_MS) return
    closeMenu()
    return
  }
  positionMenu()
}
window.addEventListener('resize', repositionMenu)
window.addEventListener('scroll', repositionMenu, true) // capture: catch inner scrollers too

// openMenu opens the palette, then a frame later (once it's rendered and its size
// is known) focuses the input and positions it just beneath the current selection.
// `mode` picks the command list (see resolveCommands): 'block' (default),
// 'comment', 'pr', 'compose', 'replyPublish', 'postApprove', 'reviewApprove',
// 'reviewChoice', 'reviewReject' or 'task' (a clicked row of the "Taken"
// block — see taskCommandsFor). It installs a FRESH `ms` reactive so the previous
// open's (undisposed) CommandMenu bindings can't fire when this menu mutates its
// state — see the note on the menu/ms split. `commands` is filled here, in this
// plain (non-reactive) function, by resolving rootCommandsFor(mode) through
// snapshotCommands — see those for why that must happen from ordinary code and
// never from inside CommandMenu's own render/filter path.
//
// `opts.native` (set by every right-click entry point — see "The right-click
// context menu" in command-palette.md) renders the native/context-menu style
// (CommandMenu's own `native` opt) and positions the box at `opts.x`/`opts.y`
// instead of under a diff-row/region anchor; a plain click/`Enter`/`/` open
// passes no opts at all, which keeps every existing behaviour unchanged.
function openMenu(mode = 'block', opts = {}) {
  const native = !!opts.native
  // Reset the cached index-row anchor on every fresh open except a follow-up
  // menu itself (isReviewFollowup — postApprove, or one of the review-submit
  // modes, see lastIndexRowRect) — this keeps the cache from ever leaking a
  // stale position into an unrelated later session; a 'block'/'pr'/etc. open
  // re-populates it immediately via positionMenu() below as long as its own
  // anchor row is visible.
  if (!isReviewFollowup(mode)) lastIndexRowRect = null
  const commands = snapshotCommands(rootCommandsFor(mode))
  // A native (right-click) menu suppresses the native browser context menu —
  // and with it, the native "Copy" item — so it needs its own, reviewer
  // request: "menu item toevoegen om selected te kunnen kopieren". Appended
  // at the END of the list (never disturbing defaultSel's "2nd item" —
  // whatever that mode's own default action already was), and ONLY when
  // there is an actual, non-empty text selection at the moment of opening
  // (window.getSelection() — a right-click never collapses an existing
  // selection the way a left-click would, so whatever the reviewer dragged
  // before right-clicking is still intact here). Deliberately absent
  // otherwise — a plain click-landed line/call selection (resolveClickSelection)
  // is a navigation cursor, not a text selection, and has no well-defined
  // "what would this copy" answer, so this never invents one.
  if (native) {
    const selectionText = window.getSelection ? window.getSelection().toString() : ''
    if (selectionText) commands.push(copySelectionCommand(selectionText))
  }
  // defaultSel starts the selection on the 2nd item — the pinned "Sluit
  // menu" (withClose) is never itself the default Enter action — falling
  // back to 0 for a mode with 0-1 real items (reviewReject's dynamic list,
  // which never gets a close item, see withClose's doc comment).
  ms = reactive({
    query: '',
    sel: defaultSel(commands, native),
    sub: null,
    mode,
    commands,
    native,
    x: opts.x || 0,
    y: opts.y || 0,
  })
  if (native) nativeMenuOpenedAt = Date.now()
  menu.open = true
  requestAnimationFrame(() => {
    // Position first — the palette starts visibility:hidden, and a hidden element
    // can't take focus, so make it visible before focusing the input. The
    // native (right-click) variant focuses it too — reviewer: "direct input
    // selecteren" — typing must work immediately, no extra click needed.
    positionMenu()
    const el = document.querySelector('[data-testid="command-input"]')
    if (el) el.focus()
  })
  // Stepping into the diff animates the panel width (200ms). If `/` is pressed
  // mid-transition the region is measured too narrow, so re-place once it settles.
  // Not relevant for a native menu — a right-click always lands on already
  // rendered, unanimated content.
  if (!native) setTimeout(() => menu.open && positionMenu(), 220)
}

// The publish follow-up is a command-palette menu, so it lives here — but the
// send that needs it starts in RelatedPanel (which never imports from this
// module). Hand the opener down once, at module load.
setReplyPublishMenuOpener(() => openMenu('replyPublish'))

// Same downward-injection shape, for Enter on an EMPTY Claude composer:
// ClaudeChat.mjs's own @keydown (RelatedPanel.mjs's openClaudeMenuFromComposer)
// knows, at the moment of the keypress, that the field was blank — long before
// this module's own document-level onKeydown would otherwise have to
// re-derive that from a DOM value that a REAL send might have just cleared in
// the same event dispatch (see the 'claude' Enter branch's own doc comment,
// and openClaudeMenuFromComposer's, for exactly why that race exists). `opts`
// forwards to openMenu unchanged — a right-click on the claude-chat-card
// (ClaudeChat.mjs) passes {native,x,y} through this exact same opener.
setClaudeMenuOpener((opts) => openMenu('claude', opts))

// Same downward-injection shape, for postThreadReply/postPrCommentReply
// (RelatedPanel.mjs): once a reply actually lands, open the row's own action
// menu instead of leaving the reviewer to navigate there by hand. See "A
// reply opens the comment's own menu instead of releasing to the diff" in
// comments-panel.md.
setCommentMenuOpener(() => openMenu('comment'))
setPrCommentMenuOpener(() => openMenu('prComment'))

// Same downward-injection shape, for the other direction a comment write needs
// to reach into this module: a freshly placed PR-wide comment must land the
// sidebar selection on its own brand-new index row. That row is created by the
// comment poll, not by loadBlocks, so it may not exist for another tick —
// which is exactly what blockRefPending + the indexComments() watch's
// applyCommentRefRestore retry already solve for `?sel=comment:<id>`. Reuse
// them rather than inventing a second "wait for that row" mechanism.
setCommentSelectRequest((commentId) => {
  blockRefPending = 'comment:' + commentId
  applyCommentRefRestore()
})

function closeMenu() {
  // Only flip the flag; the volatile state is replaced wholesale on the next
  // openMenu, and leaving this (now orphaned) `ms` untouched is exactly what
  // keeps the torn-down menu's bindings from firing against freed slots.
  menu.open = false
}

// The `mouseup` listener that used to resolve a pending mouse selection AND
// (if scheduled) show the removed passive command-palette preview now only
// does the first half: resolving a plain click / real (native) selection
// gesture is unrelated to any menu at all these days — see
// resolvePendingMouseSelection's own doc comment and "The right-click context
// menu" in command-palette.md for what replaced the passive preview.
document.addEventListener('mouseup', () => {
  resolvePendingMouseSelection()
})

// enterSubmenu swaps the visible list to a parent command's children without
// closing the palette, resetting the query/selection and repositioning (the list
// height changes). Esc later backs out via the keyboard handler.
function enterSubmenu(children) {
  ms.sub = children
  ms.query = ''
  // Same "open on the 2nd item" convention as openMenu — every submenu gets
  // its own pinned "Sluit menu" first (withClose), so start past it (unless
  // this is a native context menu, which never shows that pinned row at all
  // — see resolveCommands' own native filter).
  ms.sel = defaultSel(children, ms.native)
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
// run (e.g. the composer's cs.focus flip never reaching the DOM). Waiting
// a frame lets the close finish and flush on its own first.
function runCommand(cmd) {
  // The ONE place debug mode is instrumented by hand: which command an Enter
  // actually ran cannot be read back from the recorded keystroke (see
  // .claude/docs/debug-mode.md). A no-op while debug mode is off.
  // cmd.label is already a plain string by the time it gets here
  // (snapshotCommands resolves every label function up front), so this reads
  // no reactive state and calls nothing.
  logAction('command', (cmd && (cmd.id || (typeof cmd.label === 'string' ? cmd.label : ''))) || '')
  // A parent command opens its submenu instead of acting; keep the palette open.
  if (cmd && cmd.children) {
    enterSubmenu(cmd.children)
    return
  }
  closeMenu()
  if (cmd && cmd.run) requestAnimationFrame(() => cmd.run())
}

// contextMenuMode picks the palette mode belonging to the stop that currently
// owns the keyboard, else the general PR-wide one. Deliberately mirrors —
// rather than replaces — the Enter branches further down in onKeydown, which
// are ordered the same way.
//
// It used to be `/`'s own resolver; `/` is now unconditionally the PR menu
// (reviewer: "/ wordt altijd het PR-menu", see that branch in onKeydown), so
// its ONLY remaining caller is rightClickMenuMode below, which still needs
// exactly this "which menu would Enter open right here" answer.
//
// The modes NOT listed here are unreachable through Enter at that point by
// construction: 'compose'/'comment'/'claude' all sit behind the
// isComposeOpen()/relatedActive()/isEditableFocused() branches (a `/` typed in
// a composer must reach the field as a character) — a right-click can land
// there directly, which is why rightClickMenuMode covers them itself.
function contextMenuMode() {
  if (state.pushTodoFocused) return 'pushTodo'
  // Same hasMultiSelection() carve-out as the Enter branch below — an active
  // range whose cursor sits on a comment row still gets the range palette via
  // the 'block' mode fallthrough (blockCommands() -> rangeCommandsFor()).
  // ALSO gated on state.focusLevel <= 1 — see the matching guard on the Enter
  // branch below for why a column drilled from INSIDE the anchor's own panel
  // (focusLevel > 1) must not reopen this comment-row menu either.
  if (!state.showDescription && !hasMultiSelection() && selectedComment() && state.focusLevel <= 1) return 'prComment'
  // Stop 1 (the PR description), the two toggle rows and the batch action row
  // have no block context; so does a PR whose blocks aren't loaded (or a
  // genuinely block-less one). The batch row has no menu of its own — Enter
  // there runs the batch directly (see below) — so `/` falls through to the
  // general PR-wide one, same as the toggle rows.
  if (
    state.showDescription ||
    state.toggleFocused ||
    state.ignoreToggleFocused ||
    state.batchRowFocused ||
    state.staleRowFocused ||
    !curBlock()
  )
    return 'pr'
  return 'block'
}

// rightClickMenuMode picks the palette mode a right-click should open at
// wherever the keyboard/selection now sits (after handleContextMenu's own
// landing step has already run) — the general principle the reviewer gave:
// "rechtsklik opent hetzelfde menu dat Enter op die plek zou openen. Is er op
// die plek geen zo'n menu ... dan onderdruk je niets en blijft het native
// menu staan." Unlike `/`'s own contextMenuMode (which deliberately treats
// the description/toggle/ignoreToggle/batch rows as "fall back to the
// general PR menu", since `/` always wants to show SOMETHING searchable),
// this mirrors Enter's ACTUAL behaviour at each of those spots: three of them
// run a direct action with no menu at all (see onKeydown's own
// toggleFocused/ignoreToggleFocused/batchRowFocused branches), so this
// returns null there — a right-click leaves the native browser menu in
// place, exactly like an unchanged diff line does. `compose`/`comment`/
// `claude` — deliberately absent from contextMenuMode's own table for the
// same reason `/` never reaches them — ARE covered here, since a right-click
// (unlike `/`) can land directly inside those panels; matches
// isCommentOrThreadFocused/isClaudeChatFocused's own Enter branches, except
// deliberately more permissive on the reply-field-non-empty gate (mouse-
// navigation.md's "a click may be more permissive than the key" — the same
// reasoning the send-status button next to "Stuur" already uses).
function rightClickMenuMode() {
  if (isEditableFocused()) return null // a real text field keeps its native Cut/Copy/Paste/spellcheck menu
  // Deliberately NOT mirroring Enter's own isConvertingAiWarning() split here:
  // Enter/the "Plaats…" button skip the menu for an ordinary composer because
  // that's an unambiguous "post it" request, but a right-click is itself an
  // explicit request to SEE the available commands (mouse-navigation.md's "a
  // click may be more permissive than the key") — so it always opens the
  // comment-kind menu, conversion or not.
  if (isComposeOpen() && composeHasText()) return 'compose'
  if (relatedActive()) {
    if (isCommentOrThreadFocused()) return 'comment'
    if (isClaudeChatFocused()) return 'claude'
    // Onderliggende-code panel focused (cs.focus === 'code'): Enter there
    // drills a child, never opens a menu — see onKeydown's own isCodeFocused
    // branch — so a right-click there leaves the native menu alone too.
    return null
  }
  if (state.toggleFocused || state.ignoreToggleFocused || state.batchRowFocused || state.staleRowFocused)
    return null
  return contextMenuMode()
}

function onKeydown(e) {
  // Cmd+[ / Cmd+] — a "previous/next selected block" stack (SECOND reversal
  // of this chord's mechanism, reviewer-driven again: nav-chain remap ->
  // real browser history (c2acbc7) -> this stack. See "Cmd+[ / Cmd+]" in
  // keyboard-navigation.md — do not flip this back to real browser history
  // again). Checked FIRST, before every other branch, so it works regardless
  // of which stop/field currently owns the keyboard. `Cmd+[` steps to the
  // previously SELECTED top-level block (never a group/line/call
  // granularity step within the same block — goToPreviousBlock/
  // goToNextBlock above only ever record a real state.selected change), with
  // an empty stack falling through to /pr-overview; `Cmd+]` mirrors it
  // forward, ordinary no-op when there's nothing to redo.
  //
  // `!e.shiftKey`: Shift+Cmd+[/] is deliberately EXCLUDED and falls straight
  // through — no preventDefault — so the browser's own native Shift+Cmd+[/]
  // (tab-switching in Chrome/Safari on Mac) keeps working.
  if (isModifiedKey(e) && !e.shiftKey && (e.key === '[' || e.key === ']')) {
    e.preventDefault()
    if (e.key === '[') goToPreviousBlock()
    else goToNextBlock()
    return
  }

  // A Cmd/Ctrl chord while a text field holds DOM focus is a native caret /
  // selection / editing command — leave it to the browser, whatever the
  // review tree binds that key to. Checked here, right after the Cmd+[/]
  // remap above, and before every other branch, so no individual branch has
  // to repeat it.
  if (isNativeTextEditKey(e)) return

  // While the image lightbox is open it owns the keyboard completely — →/←
  // walk the other screenshots from the same Markdown body, Escape closes —
  // checked FIRST, mirroring the command palette's own `menu.open` guard
  // right below (see imageLightbox.mjs).
  if (isLightboxOpen()) {
    handleLightboxKeydown(e)
    return
  }

  // Same discipline for the werkmap overlay (workDirOverlay.mjs): while this
  // PR has an unanswered work-directory choice the overlay is open and owns
  // the keyboard completely — ↑/↓ pick, Enter confirms, Esc dismisses, every
  // other key is swallowed so the review tree never navigates underneath it.
  //
  // Deliberate exception: an Enter that would otherwise pick a keyboard-
  // highlighted inline Claude question option (cleanup_choice/question/
  // directory_decision — see hasHighlightedClaudeOption/
  // selectHighlightedClaudeOption in RelatedPanel.mjs) is let through instead
  // of being swallowed here. Reviewer-reported bug: the overlay's own
  // decision is a PR-WIDE read model that can become "open" because a
  // completely UNRELATED conversation's write attempt hit the same dirty
  // checkout (see the "keuze open" dead-end resumeStuckClaudeAfterCheckout
  // answers) — while that happens, this unconditional check swallowed every
  // Enter in the whole app, including one the reviewer had already aimed, via
  // ↑, at an inline option in a DIFFERENT, currently open conversation. The
  // overlay still owns ↑/↓/Escape and every Enter that has nothing inline
  // highlighted (its own normal use, including the "no inline option active"
  // case tested in checkout-overlay.spec.mjs) — only this one narrow case
  // defers to the conversation the reviewer is actually looking at.
  if (isWorkDirOverlayOpen() && !(e.key === 'Enter' && hasHighlightedClaudeOption())) {
    handleWorkDirOverlayKeydown(e)
    return
  }

  // The general-chat overlay (generalChatOverlay.mjs) owns the keyboard the
  // same way — but in the opposite direction: it deliberately swallows
  // NOTHING except Escape (which hides it again), because the reviewer is
  // typing in a real composer inside it. Returning here is the whole point:
  // no tree-navigation branch below runs while it is open.
  if (isGeneralChatOverlayOpen()) {
    handleGeneralChatOverlayKeydown(e)
    return
  }

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
        ms.sel = defaultSel(ms.commands, ms.native)
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
    } else if (e.key === ' ' && ms.query === '' && !ms.native) {
      // Space used to run the selected item too, while the search field was
      // still empty — removed on reviewer request ("spatie moet niet een keuze
      // maken... pas als ik enter druk"), then reinstated, but narrower: only
      // for the ordinary `/`/Enter palette, and only while nothing has been
      // typed yet ("als ik in het menu nog niks heb getyped, dan wil ik bij
      // een spatie ook menu item selecteren"). The `native` right-click menu
      // deliberately keeps the old behavior — Space always just types a space
      // there, even on an empty search field, per the original complaint about
      // typing freely right after a right-click. Once something is typed in
      // either menu, this branch no longer matches and Space falls through
      // untouched to the focused command-input, same as any other letter.
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
      state.ignoreToggleFocused = false
      state.batchRowFocused = false
      state.pushTodoFocused = false
      state.staleRowFocused = false
      state.showDescription = true
      state.blockIndexEntered = true
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      searchStepSelection(1)
      scrollSelectedIntoView()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      searchStepSelection(-1)
      scrollSelectedIntoView()
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault()
      if (state.toggleFocused) {
        revealApprovedBlocks()
        return
      }
      if (state.ignoreToggleFocused) {
        state.showIgnored = !state.showIgnored
        return
      }
      if (state.batchRowFocused) {
        startBatchFromRow()
        return
      }
      if (state.pushTodoFocused) {
        openMenu('pushTodo')
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

  // Enter on a filled new-comment composer that is CONVERTING an AI-controle
  // finding ("Comment hiervan maken", isConvertingAiWarning — see
  // RelatedPanel.mjs's warningOverride) opens the comment-kind menu (Claude /
  // Git / private / Jira) instead of placing directly — worth one more look
  // before an AI finding becomes a public comment. An ORDINARY composer posts
  // straight away (runComposePost, the same action "Plaats comment" in that
  // menu runs) — reviewer request: only the conversion flow deserves the
  // extra step; a plain new comment, even on a line that already carries an
  // unrelated AI warning, should just post. Handled before the
  // relatedActive() branch so it works whether the composer was opened via the
  // keyboard (cs.focus==='new') or the button (focus null). Shift+Enter is left
  // alone (newline for a multi-line comment); an empty composer does nothing.
  if (e.key === 'Enter' && !e.shiftKey && isComposeOpen()) {
    e.preventDefault()
    if (composeHasText()) {
      if (isConvertingAiWarning()) openMenu('compose')
      else runComposePost()
    }
    return
  }

  // Cmd+C on a selected Claude chat bubble (cs.claudePos >= 1, walked there
  // with ↑, see .claude/docs/claude-chat-panel.md) copies that turn's own
  // raw text to the clipboard instead of doing nothing (there is no native
  // text selection to copy, since the bubble is only keyboard-highlighted, not
  // selected) — reviewer request. isNativeTextEditKey (top of onKeydown) already
  // returns before this for a real Cmd+C in a focused composer/reply field, so
  // that case never reaches here. The two remaining "let native copy win"
  // cases are handled inline below: no active turn (activeClaudeMessageBody()
  // null at the rest position) and an actual DOM text selection (the reviewer
  // selected real text somewhere — e.g. inside the bubble itself — which a
  // browser's own Cmd+C should still copy verbatim, not the whole turn).
  if (e.key === 'c' && isModifiedKey(e) && isClaudeChatFocused()) {
    const text = activeClaudeMessageBody()
    const sel = window.getSelection()
    if (text && (!sel || !sel.toString())) {
      e.preventDefault()
      navigator.clipboard.writeText(text).catch((err) => console.error('clipboard write failed:', err))
      return
    }
  }

  // c/v resize the FOCUSED column (see startResizeKey's own doc comment) —
  // deliberately handled here, BEFORE relatedActive(), so holding c/v keeps
  // working while the keyboard already sits inside that column's own
  // Underlying-code panel / comment thread / Claude chat: relatedActive()
  // ends unconditionally in a `return` for any key it doesn't itself claim
  // (see "Generic input-focus guard" in keyboard-navigation.md), so a c/v
  // check placed after it would never fire from in there. isModifiedKey(e)
  // keeps Cmd/Ctrl+C/V as native copy/paste; isEditableFocused() is the ONLY
  // "don't hijack, let it flow into the field" guard here — deliberately
  // narrower than f/d/s/a's relatedActive()-inclusive guard, since a reviewer
  // reading a thread or an Underlying-code card (no text field focused) is
  // exactly the "also works in the sub-panels" case this was widened for; it
  // still yields the moment a composer/reply/Claude-chat field actually has
  // DOM focus. toggleFocused/ignoreToggleFocused/isTestColumnActive() stay a
  // no-op, like every other diff-only shortcut — none of those stops owns a
  // column to resize.
  if (
    (e.key === 'c' || e.key === 'v') &&
    !isModifiedKey(e) &&
    !isEditableFocused() &&
    !state.toggleFocused &&
    !state.ignoreToggleFocused &&
    !state.batchRowFocused &&
    !state.pushTodoFocused &&
    !state.staleRowFocused &&
    !isTestColumnActive()
  ) {
    e.preventDefault()
    startResizeKey(e.key)
    return
  }

  // Once the reviewer has stepped into either the inline Onderliggende-code
  // card ('code') or an inline comment conversation ('new'/'comment'/
  // 'thread', reached by → from the diff only when the selected unit has
  // comments — see hasVisibleComments/enterCommentsHead below) it owns the
  // arrows: ↑/↓/←/→ walk it (see handleRelatedKey in RelatedPanel). Handled
  // before Enter/f/d/s so those stay suspended while it's active — but typed
  // characters (letters, Enter) are left alone so they flow into the focused
  // reply field, like the menu.
  if (relatedActive()) {
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key) &&
      // ArrowLeft/ArrowRight with the caret mid-text in the composer/reply
      // textarea (cs.focus one of 'new'/'comment'/'thread') must move/
      // word-jump the caret, not exit the conversation or (for ArrowRight on
      // a comment card) jump into the thread — only hijack the key when the
      // caret has nowhere left to go on that side (empty/at the start resp.
      // at the end, e.g. a freshly opened composer — that keeps its
      // long-standing nav meaning). `isModifiedKey(e)` short-circuits this
      // exception: it is only ever true here for the Cmd+[/Cmd+] remap above,
      // since a really-pressed Cmd/Ctrl+arrow in a focused field never gets
      // this far (isNativeTextEditKey returns it at the top of onKeydown —
      // before that guard existed, a real Cmd+← DID land here and was
      // wrongly treated as navigation instead of "caret to start of line").
      // Cmd+[/] is no native caret-move shortcut in a text field, so it must
      // always hit the nav chain instead of moving/word-jumping the caret.
      !(e.key === 'ArrowLeft' && editableCaretCanMoveLeft() && !isModifiedKey(e)) &&
      !(e.key === 'ArrowRight' && editableCaretCanMoveRight() && !isModifiedKey(e)) &&
      // ArrowUp/ArrowDown get the exact same treatment on the vertical axis —
      // a wrapped, multi-visual-line textarea must let the caret walk up/down
      // its own rows first, only hijacking the key once the caret is already
      // on the field's first/last VISUAL line (see editableCaretCanMoveUp/
      // Down; a plain INPUT never wraps, so it keeps today's behavior there).
      !(e.key === 'ArrowUp' && editableCaretCanMoveUp()) &&
      !(e.key === 'ArrowDown' && editableCaretCanMoveDown())
    ) {
      e.preventDefault()
      const relatedResult = handleRelatedKey(e.key)
      // ↓ at the bottom of the embedded Claude conversation — the rest
      // position (claudePos === 0) with the chat's own code blocks
      // (cs.previewPos) already walked through — returns this sentinel
      // instead of falling into the Onderliggende-code panel. At the TOP
      // level (explicit request — see handleRelatedKey's own doc comment)
      // that advances straight to the next visible block's diff. Inside a
      // DRILLED column (state.focusLevel > 0) there is no "next block in the
      // sidebar" to speak of — the reviewer is reviewing THIS unit's own
      // Underlying code, e.g. a resolved call right below the Claude
      // conversation — so it continues into that same column's own
      // Onderliggende-code panel instead (enterRelatedFromClaudeChat).
      // Reported bug: ↓ there used to jump the top-level sidebar selection to
      // an unrelated block elsewhere in the PR.
      if (relatedResult === 'advance') {
        if (state.focusLevel > 0) enterRelatedFromClaudeChat()
        else advanceToNextBlockFromClaudeChat()
        return
      }
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
    // Enter on a focused comment card (reply field empty — see commentReplyEmpty)
    // opens the comment-scoped menu (delete, resolve, edit, for now) instead of
    // falling through to the reply field. A non-empty reply field is left alone
    // so "type a quick reply, hit Enter" (the reply input's own keydown handler)
    // still works. Also reachable while stepped ↑ into one of the thread's own
    // replies (isCommentOrThreadFocused, not just the rest position) — that is
    // exactly how "Bewerk bericht" reaches a reply, not just the root message,
    // mirroring the comment-index item's own Enter (which already opens
    // regardless of its thread-walk position).
    // `!e.shiftKey` is load-bearing, not defensive: commentReplyEmpty() reads
    // the THREAD'S OWN reply field (`reaction-compose`), which is a different
    // element from the inline edit textarea (`message-edit-compose`,
    // editingBubble in RelatedPanel.mjs) and stays empty while editing — so
    // without this guard, Shift+Enter typed to add a newline while editing an
    // own message always matched this branch too (reply field genuinely
    // empty) and popped the action menu on top of the edit instead of
    // inserting the newline. See "Editing an own message" in
    // .claude/docs/comments-panel.md.
    if (e.key === 'Enter' && !e.shiftKey && isCommentOrThreadFocused() && commentReplyEmpty()) {
      e.preventDefault()
      openMenu('comment')
    }
    // Enter while a question's option is highlighted (↑/↓ walked into it, see
    // the 'claude' branch of handleRelatedKey / cs.claudeOptionSel) sends that
    // option, exactly like clicking it — checked BEFORE the "open the Claude
    // menu" branch right below, since the composer is deliberately blurred
    // while an option is highlighted (focusClaudeComposer) and would otherwise
    // match that branch's own DOM-focus check instead.
    if (e.key === 'Enter' && isClaudeChatFocused() && selectHighlightedClaudeOption(state, commentTarget)) {
      e.preventDefault()
      return
    }
    // Enter while a row of the "other running Claude tasks" nested stop is
    // highlighted (↓ walked past this chat's own code-preview cards, see
    // cs.claudeTasksPos/otherClaudeChats in RelatedPanel.mjs) jumps to
    // that conversation, exactly like clicking it (jumpToClaudeConversation,
    // registered via setClaudeTaskJump). Checked for the same reason as the
    // option branch right above it — this rung also blurs the composer.
    // isFooterTasksFocused() covers the same rung reached with no anchor at
    // all (enterFooterTasks, cs.focus === 'tasks') — see
    // .claude/docs/claude-chat-panel.md.
    if (e.key === 'Enter' && (isClaudeChatFocused() || isFooterTasksFocused()) && selectHighlightedClaudeTask()) {
      e.preventDefault()
      return
    }
    // Enter while one of the pending-edits card's own links is highlighted
    // (↓ walked into it — see cs.editLinkSel in RelatedPanel.mjs) jumps to
    // that block, exactly like clicking it — checked for the same reason as
    // the task/option branches above: a highlighted link also blurs the
    // composer, so it would otherwise match the generic toggle branch below
    // (which only ever collapses/expands the card, never navigates).
    if (e.key === 'Enter' && isClaudeChatFocused() && selectHighlightedEditLink()) {
      e.preventDefault()
      return
    }
    // Enter while the cursor sits on one of the chat's own code-preview cards
    // (RelatedPanel.mjs's cs.previewPos > 0, see "Default-collapsed cards" in
    // claude-chat-panel.md — activeCodePreviewKey() returns null off it, home.mjs
    // never reads cs directly) toggles that ONE card's in-/uitklappen state
    // instead of opening the Claude column's menu below — checked BEFORE
    // that branch for the same reason as the option/task branches above: a
    // highlighted card also blurs the composer, so it would otherwise match
    // that branch's own DOM-focus check too.
    if (e.key === 'Enter' && isClaudeChatFocused()) {
      const key = activeCodePreviewKey()
      if (key != null) {
        e.preventDefault()
        toggleCodePreviewExpanded(key)
        return
      }
    }
    // Enter on the focused Claude column opens its own small menu ("Wis
    // Claude-gesprek" + — while the anchor is still empty, see
    // claudeAnchorIsPlaceholder — "Comment hiervan maken", behind a confirm
    // submenu for the former — see claudeChatCommandsFor) — but only while the
    // composer itself is NOT the focused element: focusClaudeComposer only
    // focuses it at claudePos===0 (the rest position, where Enter must keep
    // sending/newlining via ClaudeChat.mjs's own @keydown) and explicitly
    // BLURS it for any stepped-up position (claudePos > 0, walking the
    // transcript) — exactly the state this menu is meant for. A DOM-focus
    // check rather than reading the composer's VALUE (unlike commentReplyEmpty
    // for the comment column) — the composer clears its own value
    // synchronously on send, so a value check here would race that clear and
    // reopen this menu right after an ordinary send.
    //
    // Enter on an EMPTY, focused composer (the rest position) reaches this
    // SAME menu too, but via a different path: ClaudeChat.mjs's own @keydown
    // (which already knows, at the moment of the keypress and before
    // anything could mutate the field, whether it was blank) calls its
    // onEmptyEnter callback, which resolves — through
    // setClaudeMenuOpener(() => openMenu('claude')) below — to the exact same
    // openMenu('claude') this branch calls. Deliberately NOT folded into this
    // branch's own condition: re-deriving "was it blank" here, after the
    // event has already bubbled past ClaudeChat.mjs's handler, cannot
    // distinguish a genuinely blank Enter from an ORDINARY non-blank send
    // (whose handler just cleared the field in that same dispatch) — see
    // openClaudeMenuFromComposer's doc comment (RelatedPanel.mjs).
    if (
      e.key === 'Enter' &&
      isClaudeChatFocused() &&
      document.activeElement !== document.querySelector('[data-testid=claude-chat-compose]')
    ) {
      e.preventDefault()
      openMenu('claude')
    }
    // Enter (or Space — same action, reviewer request) on the Onderliggende-code
    // block drills into the resolved child the cursor is sitting on as its own
    // diff column (see drillIntoChild) — recursing into its Onderliggende code.
    // Unresolved calls no longer need a manual Enter/Space: the LLM search runs
    // automatically (see the setRelated watch / startCallSearch).
    // If the cursor instead sits on a drill-hint chip (cs.chipPath, → descended
    // into it — see RelatedPanel's handleRelatedKey), Enter/Space drills through
    // the WHOLE chain (the card, then every intermediate chip, then the focused
    // chip) in one go — exactly what a click on that chip already does (see
    // nestedChip's own @click), just via the keyboard.
    if ((e.key === 'Enter' || e.key === ' ') && isCodeFocused()) {
      e.preventDefault()
      const chain = focusedChipChain()
      if (chain) {
        for (const target of chain) drillIntoChild(target)
      } else {
        const child = focusedRelatedChild()
        if (child) handleRelatedDrill(child)
      }
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

  // Escape drops an active Shift+arrow multi-selection (a list-index range,
  // a methodes-kolom range, or a diff-level line/group range at the current
  // focus level) back to a single cursor. Deliberately checked here — AFTER
  // the menu/search-box/relatedActive()/isEditableFocused() branches above,
  // which each already claim Escape for their own purpose and return before
  // reaching this point — so opening the range palette (or any other menu)
  // and running an action from it never touches the selection; only a bare
  // Escape, pressed with none of those open, does. Reviewer request: running
  // an action (approve/comment/chat/ignore) on the selection does NOT clear
  // it by itself — it stays exactly as-is, including after the action
  // completes, until either an ordinary plain arrow key or Escape clears it,
  // or navigation actually moves to a block outside it (both already handled
  // by the existing clearListAnchor()/clearRangeAnchor() call sites — see
  // their own doc comments). A no-op when nothing is selected, so a bare
  // Escape elsewhere keeps doing nothing, as before.
  if (
    e.key === 'Escape' &&
    (state.listAnchor != null ||
      state.methodAnchor != null ||
      state.rangeAnchor != null ||
      (state.drillCursor[state.focusLevel - 1] && state.drillCursor[state.focusLevel - 1].rangeAnchor != null))
  ) {
    e.preventDefault()
    clearListAnchor()
    clearRangeAnchor()
    return
  }

  // `/` ALWAYS opens the general PR-wide menu, wherever the keyboard is.
  //
  // This deliberately REVERSES the earlier "`/` opens the menu of the current
  // stop" rule (contextMenuMode, still used by the right-click menu below):
  // reviewer decision — "/ wordt altijd het PR-menu". The general chat has to
  // be startable from every stop, including a selected code line, and typing
  // a question the PR menu doesn't match now falls back to "Chat over deze PR"
  // (see resolveCommands). "Chat over deze regel" is unchanged but reachable
  // through `Enter` only. Like Enter it's handled before the empty-blocks
  // guard so it works while loading; a focused input (composer/reply) is
  // already caught by the relatedActive()/isEditableFocused() branches above,
  // so a typed `/` there still reaches the field as a character.
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
    revealApprovedBlocks()
    return
  }

  // Mirror of the toggle-approved branch above, for the toggle-ignored row.
  if (e.key === 'Enter' && state.ignoreToggleFocused) {
    e.preventDefault()
    state.showIgnored = !state.showIgnored
    return
  }

  // The batch action row runs the comment_batch run directly, no confirm
  // step — see startBatchFromRow's own doc comment for why (unlike the
  // push-todo row right below, which DOES need one).
  if (e.key === 'Enter' && state.batchRowFocused) {
    e.preventDefault()
    startBatchFromRow()
    return
  }

  // The push-todo row (the bottom-most stop, see stepListSelection) is the one
  // trailing row whose Enter does something to the outside world, so — unlike
  // the two toggles — it never acts directly: it opens a one-more-step confirm
  // menu, the same two-step shape "Wis Claude-gesprek" and "Keur de HELE PR
  // goed" use (see pushTodoCommandsFor).
  if (e.key === 'Enter' && state.pushTodoFocused) {
    e.preventDefault()
    openMenu('pushTodo')
    return
  }

  // The stale-tree notice (state.staleRowFocused, see stepListSelection) runs
  // its own reload directly on Enter — the keyboard twin of its `@click`
  // (staleTreeRow, BlockList.mjs) — there is no menu for it, same shape as the
  // two toggle rows above.
  if (e.key === 'Enter' && state.staleRowFocused) {
    e.preventDefault()
    window.location.reload()
    return
  }

  // Enter on a selected comment-index item (kind:'comment', synthesized from a
  // PR-wide comment into the sidebar — see recomputeLeftList/
  // commentBlockItem) opens its own small action menu ("Beantwoorden" /
  // "Resolve comment", prCommentCommandsFor) instead of the block palette —
  // there is no diff to act on. Checked before the generic Enter-opens-menu
  // branch below so it wins for this item. Explicitly gated on
  // !state.showDescription: state.selected can still point at a comment item
  // while stop 1 (the PR-description column) owns the keyboard (the reviewer
  // selected a comment row, then stepped left) — Enter there must open the
  // PR-wide menu, not this item's own comment menu.
  // ALSO gated on !hasMultiSelection(): an active Shift+arrow range whose
  // cursor happens to sit on a comment row must still open the range palette
  // (rangeCommandsFor, below) — the whole point of "Ignore N comments in dit
  // bereik" is reachable regardless of which row the cursor ended up on, see
  // command-palette.md.
  // ALSO gated on state.focusLevel <= 1: a child drilled from INSIDE the
  // anchor's own Underlying-code panel (state.focusLevel > 1, see
  // drillIntoChild/openCommentAnchorDrill and the matching ArrowUp/ArrowDown
  // fix above) has nothing to do with this comment's own thread any more —
  // state.selected still points at the sidebar comment row (openCommentAnchorDrill
  // never touches it), so selectedComment() stayed truthy and this branch
  // wrongly reopened "Beantwoorden"/"Resolve comment" instead of the ordinary
  // block palette that already targets that drilled child + its own active
  // line-range (approveContext()/commentTarget() already generalize via
  // focusLevel — see "A child drilled from inside the anchor's own panel
  // must own ↑/↓ too" in comments-panel.md). Reported bug: "ik kan
  // vervolgens niet meer op enter drukken op wat ik dan heb geselecteerd".
  if (e.key === 'Enter' && !state.showDescription && !hasMultiSelection() && selectedComment() && state.focusLevel <= 1) {
    e.preventDefault()
    openMenu('prComment')
    return
  }

  // Enter opens the palette at the next-block slot. Handled before the empty-blocks
  // guard so it works even while a PR is still loading. On stop 1 (the
  // PR-description column, state.showDescription) there's no block context, so
  // it opens the same PR-wide menu as `/` instead of the block-scoped palette —
  // block 0 in the list is a different stop (showDescription is false there)
  // and keeps the normal block palette. Stop 2b (the methodes-kolom, see
  // isTestColumnActive) is a deliberate exception, handled inside this block
  // below: a plain Enter there mirrors ↓ (stepTestColumnRow) instead of
  // opening the palette — reviewer request: "als ik enter druk, wil ik dat de
  // volgende blokken test index blok item wordt geselecteerd, dus dat ik
  // hetzelfde ziet als naar beneden." An active Shift+↓ range still opens the
  // palette on Enter ("Keur deze N methodes goed", hasMultiSelection()), same
  // as everywhere else in the list. Only → (handled further below,
  // isTestColumnActive's own ArrowRight branch) keeps stepping into the
  // active method's diff.
  if (e.key === 'Enter') {
    e.preventDefault()
    // A focused "Taken" row is its own stop within stop 1, so Enter there opens
    // that ROW's menu ('task') instead of the PR-wide one — the keyboard twin of
    // clicking it (openTaskRowMenu). Same shape as the push-todo row's own
    // Enter, and it re-resolves the cursor key against the current list, so a
    // row that vanished under a poll falls through to the 'pr' menu.
    // Enter on a focused, capped since-review block opens it up to its full
    // text instead of a menu (reviewer: "je mag het afkappen, maar als ik enter
    // druk op z'n blok dan wil ik de volledige omschrijving lezen"). A block
    // that is short enough to show in full has nothing to open, so it falls
    // through to the PR-wide menu as before.
    // Enter on the focused BLOCK-description strip (stop 3's own extra ↑ stop,
    // see blockDescFocused) opens its 2-line cap to the full text instead of
    // opening the block palette — the same shape stop 1's since blocks and its
    // Omschrijving block already have. There is no unit context while the strip
    // owns the cursor, so a palette would be wrong here anyway; a description
    // short enough to fit in full has nothing to open and Enter is a no-op
    // (toggleBlockDescExpanded's own blockDescCollapsible guard).
    if (blockDescFocused()) {
      toggleBlockDescExpanded()
      return
    }
    const sinceSec = state.showDescription ? focusedSinceSection() : null
    if (sinceSec && sinceCollapsible(sinceSec)) {
      toggleSinceExpanded(sinceSec)
      return
    }
    // Same deal for the focused "Omschrijving" block: Enter reads it in full
    // instead of opening a menu, and a description short enough to be shown
    // whole falls through to the PR-wide menu as before.
    if (state.showDescription && state.taskFocus === DESC_FOCUS_KEY && descCollapsible(state)) {
      toggleDescriptionExpanded()
      return
    }
    const taskRow = state.showDescription ? focusedTaskRowFromState() : null
    if (taskRow) {
      openTaskRowMenu(taskRow, null)
      return
    }
    // Stop 2b (the methodes-kolom): a plain Enter mirrors ↓ instead of
    // opening the block palette — see this branch's own comment above. Gated
    // on !hasMultiSelection() the same way the comment-index Enter branch
    // above is, so an active Shift+↓ range still falls through to the
    // ordinary openMenu('block') -> rangeCommandsFor() palette.
    if (isTestColumnActive() && !hasMultiSelection()) {
      stepTestColumnRow(1)
      return
    }
    openMenu(state.showDescription ? 'pr' : 'block')
    return
  }

  // Stop 1 of the nav chain (the PR-description column) sits to the left of the
  // block-index and owns the keyboard while open: → closes it back to stop 2,
  // ← exits the chain entirely to the PR overview (/pr-overview) — there's
  // nothing further left than stop 1. Any other key is a no-op and doesn't move
  // the block selection underneath it. The `?pr=`/`?sel=` params let
  // /pr-overview auto-select the PR — and hand back the same block reference on
  // return — we just came from (see overviewExitUrl above, and
  // trySelectPendingPr()/originPr/originSel in overview.mjs).
  //
  // Deliberately checked here, BEFORE the `state.blocks.length === 0` guard and
  // the toggle-row guard right below: a fresh, fully-approved-PR open (or a
  // genuinely block-less PR) can land BOTH state.showDescription and
  // state.toggleFocused true at once (applyDefaultUnapprovedSelection), or leave
  // state.blocks empty — either guard sitting first used to swallow ArrowRight/
  // ArrowLeft before this branch ever saw them, leaving stop 1 permanently
  // stuck open with no way to close or exit it. See "toggleRow" in
  // BlockList.mjs and .claude/docs/keyboard-navigation.md for the corrected
  // account of both root causes.
  if (state.showDescription) {
    e.preventDefault()
    // ↓/↑ walk into (and back out of) the "Taken" block below the description
    // card — stop 1 used to swallow both keys entirely. stepTaskFocus returns
    // false when there is nothing to walk into (an empty list, or ↑ while the
    // description card already has the focus), which keeps the key the same
    // no-op it was. See "Walking into the Taken block" in
    // .claude/docs/keyboard-navigation.md.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      stepTaskFocus(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'ArrowRight') {
      // → is the nav chain's own step to the right, from a focused Taken row
      // just as much as from the description card itself: the reviewer asked to
      // reach the diff from here, not to have to walk back up first.
      state.taskFocus = ''
      state.showDescription = false
      // → out of stop 1 is a nav-chain step, so the column really goes away —
      // including when a mouse click had pinned it open earlier (see
      // state.descriptionPinned). Without this, the keyboard could no longer
      // close a column it had just closed.
      state.descriptionPinned = false
      // A real crossing into the block index — from here on a selected row
      // reads as a genuine choice, not the fresh-open default (see
      // state.blockIndexEntered's own comment).
      state.blockIndexEntered = true
      // Deliberately does NOT clear state.toggleFocused/etc. here — a
      // fully-approved PR legitimately lands on the toggle-approved row right
      // after this crossing (see the "everything approved" test above), and
      // that flag must survive it. The stale-flag bug this comment used to
      // describe a fix for here was actually a different codepath (a mouse
      // click forcing diff mode via ensureTopLevelDiffFocus/enterDiff while
      // toggleFocused was still set from list mode) — see enterDiff's own
      // clear of these flags below.
    } else if (e.key === 'ArrowLeft') location.href = overviewExitUrl()
    return
  }

  if (state.blocks.length === 0) return

  // Same trailing-row special case as Enter above: none of these diff-only
  // shortcuts (zoom, view-toggle, step into the diff) mean anything while
  // either toggle row owns the keyboard — state.selected still points at
  // whatever block it did before ↓ walked onto the button, and letting them
  // silently act on it would read as broken ("I'm on the toggle button but
  // ArrowRight opened a diff"). A held Cmd/Ctrl is excluded here too (see the
  // isModifiedKey note below) so e.g. Cmd+A still selects text natively even
  // while a toggle row happens to have keyboard focus. Space (approve +
  // continue, see spaceKey below) joins this list for the same reason — a
  // toggle row is not a PR block, there is nothing there to approve.
  if (
    (state.toggleFocused ||
      state.ignoreToggleFocused ||
      state.batchRowFocused ||
      state.pushTodoFocused ||
      state.staleRowFocused) &&
    !isModifiedKey(e) &&
    ['f', 'd', 's', 'a', ' ', 'ArrowRight'].includes(e.key)
  ) {
    e.preventDefault()
    return
  }

  // The methodes-kolom (stop 2b, see isTestColumnActive) has no diff context
  // of its own to zoom/toggle — f/d/s/a are a deliberate no-op there, same
  // reasoning as the toggle-row guard just above. ↑/↓/→/← are handled in
  // their own dedicated block further below, before the generic list-mode
  // arrows.
  if (isTestColumnActive() && !isModifiedKey(e) && ['f', 'd', 's', 'a'].includes(e.key)) {
    e.preventDefault()
    return
  }

  // The BLOCK-description strip (stop 3's own extra ↑ stop, see
  // blockDescFocused) has no unit context either, so f/d/s/a/Space are the same
  // deliberate no-op there as on stop 1 and in the methodes-kolom above —
  // approving or zooming a description makes no sense, and letting them fall
  // through would silently move the diff cursor underneath the strip. ↑/↓/←/→
  // and Enter are handled in the diff-mode block resp. the Enter branch above.
  if (blockDescFocused() && !isModifiedKey(e) && ['f', 'd', 's', 'a', ' '].includes(e.key)) {
    e.preventDefault()
    return
  }

  // f / d / s drive the zoom-based selection: f zooms in (and steps to the next
  // call on the finest level), d goes back, s zooms out. f from the list steps
  // into the diff first; d / s only act inside a diff. See fKey / dKey / sKey.
  // isModifiedKey(e) (Cmd/Ctrl held) lets these single letters fall through to
  // the browser/OS instead — Cmd+F (find), Cmd+D (bookmark), Cmd+S (save) — the
  // same reasoning as the `a` guard just below.
  if (e.key === 'f' && !isModifiedKey(e)) {
    e.preventDefault()
    fKey()
    return
  }
  if (e.key === 'd' && !isModifiedKey(e)) {
    e.preventDefault()
    dKey()
    return
  }
  if (e.key === 's' && !isModifiedKey(e)) {
    e.preventDefault()
    sKey()
    return
  }

  // Space — on an ordinary block/unit: approve it (whole block in list mode,
  // else the current group/line/call, exactly like the palette's "Keur ...
  // goed" — see approveContext/toggleApprove) and continue straight to the
  // next unapproved unit in one keypress, without ever showing the
  // postApprove confirm menu. Already standing on an approved unit just jumps
  // to the next one, and reaching the end opens the same review-submit menu
  // as the natural end of a "Ga door" chain.
  // On a comment-index row Space does something else entirely — see
  // spaceKey's own doc comment for why resolving was moved OFF this key.
  // !state.showDescription mirrors the Enter branch above: stop 1 (the
  // PR-description column) has no block context to approve, same reason Enter
  // there opens the 'pr' menu instead of 'block'. preventDefault always fires
  // here so the key never scrolls the page or (were a focusable element to
  // hold real DOM focus) activates it instead.
  if (e.key === ' ' && !isModifiedKey(e) && !state.showDescription) {
    e.preventDefault()
    spaceKey()
    return
  }

  // `a` cycles the diff-pane view everywhere (every visible Block card: the
  // selected/preview cards and every open drilled column) through
  // DIFF_VIEW_CYCLE: full side-by-side (default) → unified (a two-sided
  // block collapses to one "old above new" column), fixed 60% width →
  // 'fit' (new code only — old is never shown, even for a two-sided block
  // — sized to that pane's own code) → back to
  // split. Placed alongside f/d/s so it's guarded by the same earlier
  // menu/search/related checks above — except
  // those key on cs.focus (relatedActive()), which stays null when the composer
  // is opened via a path that only flips cs.focus to 'new' (e.g. the command
  // palette's "Maak hiermee een comment" fallback, see startComment in
  // RelatedPanel.mjs) without ever routing through the panel's own keyboard
  // navigation. A literal "a" typed there would otherwise be eaten by this
  // shortcut instead of reaching the textarea, so guard directly on whether an
  // editable field currently holds DOM focus. isModifiedKey(e) additionally lets
  // Cmd+A / Ctrl+A fall through untouched — the diff/code panes are plain,
  // non-input text (isEditableFocused() doesn't cover them), so without this the
  // reviewer could never trigger the browser's native "select all" while their
  // focus/selection was anywhere near the diff. See isModifiedKey below.
  if (e.key === 'a' && !isEditableFocused() && !isModifiedKey(e)) {
    e.preventDefault()
    toggleDiffView()
    return
  }

  // Stop 2b of the left→right nav chain (the methodes-kolom, see
  // isTestColumnActive/TestMethodsColumn.mjs): ↑/↓ walk the class's own
  // methods; at the class edges (past the last/first method) they exit back
  // to the index and step exactly ONE row further (the next/previous visible
  // row, ALSO a non-test row — never skipping ahead to the next test_class
  // row, which the old stepTestMethod flow-through did; that flow-through is
  // now diff-mode-only, see stepTestMethodChange). No further row in that
  // direction → clamp: keep the column focus, do nothing (never fall through
  // into the toggle-rows/search-box loop — that's stop 2's own behaviour).
  // →/Enter step into the diff of the active method (mirrors → from the
  // pr-index into an ordinary block's diff); ← steps back out to the
  // pr-index (stop 2). Checked before the generic list-mode arrows below so
  // it wins whenever this column owns the keyboard.
  if (isTestColumnActive()) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      // Shift extends a multi-method selection instead of moving the cursor
      // (see extendMethodRange) — clamped within this class's own methods.
      if (e.shiftKey) {
        extendMethodRange(dir)
        return
      }
      stepTestColumnRow(dir)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      enterDiff()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      state.testColumnFocused = false
    }
    return
  }

  if (state.mode === 'diff') {
    // The description strip owns ↑/↓/←/→ while the cursor sits on it (see
    // blockDescFocused): ↓ drops back onto the block's first change, ↑ leaves
    // the block entirely the way it always did (the same-file neighbour, or
    // clamp at a file boundary — so the strip really is ONE extra step in that
    // walk, not a dead end), and ←/→ release it and then do exactly what they
    // do from the diff itself. Shift is ignored here: a range selection needs a
    // unit, which a description isn't.
    if (blockDescFocused() && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault()
      if (e.key === 'ArrowDown') {
        leaveBlockDesc()
      } else if (e.key === 'ArrowUp') {
        clearBlockDescFocus()
        if (curTestClassRow()) stepTestMethodChange(-1)
        else stepBlock(-1)
      } else if (e.key === 'ArrowLeft') {
        clearBlockDescFocus()
        leaveDiffToList()
      } else {
        clearBlockDescFocus()
        clearRangeAnchor()
        enterCommentsOrRelated(state.pr)
      }
      return
    }
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
      // ↑ off the block's FIRST unit lands on the description strip first (one
      // extra step) when this block has one, instead of flowing straight into
      // the previous same-file block — reviewer request: "ik moet naar boven
      // kunnen en dat moet dan een extra stap zijn". A second ↑ then continues
      // that flow, see the blockDescFocused branch at the top of this block.
      else if (state.change <= 0 && blockDescStopAvailable()) focusBlockDesc()
      else prevChange()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      // Close the focused drilled column and step focus back onto the diff of
      // its parent column (the closed child reappears in the parent's
      // Related-code list — that list is driven by focusedBlock() via the
      // setRelated watch, so it updates on its own once focusLevel drops;
      // repeated ArrowLeft peels back one drilled level at a time), or, with
      // nothing drilled, leave the diff session entirely back to the list.
      // Both bodies live in closeDrilledColumn/leaveDiffToList (above
      // expandColumn) so the matching mouse entry points
      // (Block.mjs's blockCloseColumnButton / MainScrollLeftHint's
      // stepMainLeftOneColumn) can call the exact same functions — see
      // mouse-navigation.md.
      if (state.focusLevel > 0) closeDrilledColumn()
      else leaveDiffToList()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      // Stepping right leaves this column's diff — clear any active
      // line-range selection, mirroring every other navigation path that
      // supersedes one (see clearRangeAnchor). Lands on the first inline
      // comment conversation of the selected unit if there is one and it
      // isn't already resolved, else on the next open comment/Underlying
      // code (see enterCommentsOrRelated in RelatedPanel.mjs). With no
      // comment at all it enters the embedded Claude chat ONLY when that
      // column actually exists — i.e. an earlier conversation is hanging on
      // a comment that isn't in the visible index (claudeChatVisible). With
      // neither, → falls straight through to the Onderliggende-code panel, as
      // it always did: nothing auto-creates a comment to hang a chat on.
      clearRangeAnchor()
      enterCommentsOrRelated(state.pr)
    }
    return
  }

  // A selected comment-index item's thread (entered via → below, see
  // enterPrCommentThread) owns ↑/↓/←/→ while focused — the sidebar counterpart
  // of the block-scoped inline-comment thread's own ↑/↓/←/→ handling
  // (handleRelatedKey's 'thread' branch): ↑/↓ walk the thread's messages, ←
  // steps back out to the index, and → steps ONE level further into the
  // Claude column already standing next to the item (stop 5b, the same
  // enterClaudeChat that branch's own → reaches — see
  // handlePrCommentThreadKey). Checked before the generic list-mode arrows
  // below so it wins for this item; Enter still opens the action menu
  // regardless (see the Enter branch above), untouched by this.
  // ↓ at the newest message FALLS THROUGH instead of clamping —
  // handlePrCommentThreadKey already exits the thread itself and returns
  // `false` in that case, so we fall into the ordinary stepListSelection(1)
  // below to advance to the next comment/block (mirrors the block-scoped
  // panel's ↓-falls-through convention, see detail-layout.md).
  const focusedListComment = selectedComment()
  if (
    focusedListComment &&
    isPrCommentThreadFocused(focusedListComment) &&
    (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
  ) {
    e.preventDefault()
    if (handlePrCommentThreadKey(focusedListComment, e.key)) return
    stepListSelection(1)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
    return
  }

  // A comment-index item anchored to a real block can be drilled ONE level
  // DEEPER still: from inside its own Underlying-code panel (reached via a
  // second ArrowRight, cs.focus==='code') Enter/Space on a resolved child
  // calls the ordinary drillIntoChild — exactly as it would for any other
  // block — pushing a SECOND (or deeper) state.drill entry and bumping
  // state.focusLevel past 1. drillIntoChild also calls leaveRelated(), so
  // relatedActive() is false again and the branch above no longer claims the
  // key. Unlike the level-1 "comment row still walks the sidebar until the
  // second →" design (state.commentAnchorEntered, an explicit, documented
  // reviewer decision — see "Only one thing reads as selected at a time" in
  // .claude/docs/comments-panel.md — deliberately UNTOUCHED here, hence
  // `> 1` and not `> 0`), a genuinely deeper drilled column has no sidebar
  // meaning left at all: state.mode simply never flips to 'diff' for this
  // one flow (openCommentAnchorDrill's own exception, see drilling.md), so
  // without this branch ↓/↑ fell through to the generic list-mode handling
  // below and silently moved the SIDEBAR selection (or, with Shift, jumped a
  // whole different comment/block into view) instead of walking the open
  // drilled column — reported bug: "als ik een onderliggende kaart open van
  // een comment, kan ik daarna niet meer naar beneden drukken want dan
  // selecteert het de blokken index". This mirrors state.mode==='diff''s own
  // focusLevel > 0 handling below verbatim, just reached from 'list' mode.
  if (state.focusLevel > 1 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    if (e.key === 'ArrowDown') {
      if (e.shiftKey) drillExtendRange(state.focusLevel, 1)
      else drillNextChange()
    } else {
      if (e.shiftKey) drillExtendRange(state.focusLevel, -1)
      else drillPrevChange()
    }
    return
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    // Shift extends a multi-ROW selection in the index instead of moving the
    // cursor one row (see extendListRange) — the sidebar twin of the diff's
    // own Shift+arrow line range.
    if (e.shiftKey) {
      extendListRange(1)
      return
    }
    stepListSelection(1)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (e.shiftKey) {
      extendListRange(-1)
      return
    }
    stepListSelection(-1)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    // A selected comment-index item (kind:'comment', see recomputeLeftList)
    // has no diff of its own to step into — → instead reaches whatever the
    // comment's own anchor block offers:
    //
    // - Anchored (commentAnchorBlock resolves): the anchor's block is
    //   already open as a drilled column (state.drill[0], opened
    //   automatically on selection by openCommentAnchorDrill — see its own
    //   doc comment), but the keyboard never moved into it, and its active
    //   row stays un-highlighted (commentAnchorAwaitingEntry). Reviewer
    //   request: "als ik 1 keer naar rechts ga, selecteer code, als ik 2
    //   keer naar rechts ga selecteer dan eerste openstaande comment" — a
    //   FIRST → only flips state.commentAnchorEntered, revealing the diff's
    //   active-row highlight (mirroring the ordinary "step into the diff"
    //   stop every other block gets) while the keyboard stays on the
    //   sidebar list (↑/↓ keep walking the index, exactly as before this
    //   →). Only a SECOND → (commentAnchorEntered already true) hands the
    //   keyboard IN, mirroring the state.mode==='diff' ArrowRight branch
    //   above verbatim: lands on the first inline comment conversation if
    //   there is one and isn't already resolved, else the next open
    //   comment/Underlying code, else the embedded Claude column if one is
    //   hanging on it, else the Onderliggende-code panel (see
    //   enterCommentsOrRelated in RelatedPanel.mjs). This is what makes the
    //   expanded view fully keyboard-navigable (reviewer request) despite
    //   state.mode staying 'list' — relatedActive()'s ↑/↓/←/→ handling is
    //   unconditional on mode.
    // - Unanchored (a genuine PR-wide/orphan comment, nothing to drill into):
    //   unchanged — steps into the comment's own thread message history
    //   (its own separate pct/enterPrCommentThread cursor, RelatedPanel.mjs —
    //   NOT the block-scoped cs.focus/'thread' state machine, which reaches
    //   'thread' only via ↑, see .claude/docs/claude-chat-panel.md). A SECOND
    //   → from there continues into the Claude column standing next to the
    //   item (stop 5b) — handled by the pct branch above, so this line only
    //   ever runs for the very first →.
    const sc = selectedComment()
    if (sc) {
      const anchor = commentAnchorBlock(sc)
      if (anchor) {
        if (!state.commentAnchorEntered) {
          state.commentAnchorEntered = true
        } else {
          clearRangeAnchor()
          // An "Openstaande chats" row (curBlock().chatOnly, see
          // recomputeLeftList/openChatComments) always lands the keyboard
          // directly IN the chat, skipping the comment-thread step
          // entirely — reviewer request: "als ik vanuit de blokken index
          // 2x naar rechts ga, en er is geen comment, dan wil ik gelijk in
          // de chat belanden", even though the anchor comment technically
          // exists. See .claude/docs/claude-chat-panel.md.
          if (curBlock().chatOnly) enterClaudeChat(state.pr)
          else enterCommentsOrRelated(state.pr)
        }
      } else if (curBlock() && curBlock().generalChat) {
        // The general chat's own row (chatBlockItem/isGeneralChatAnchor) has
        // no anchor block AND no comment thread worth stepping into — its
        // anchor is an invisible placeholder. → therefore opens the overlay
        // straight away, the same single surface the `/`-menu opens
        // (reviewer: "als ik vanuit de blokken index 2x naar rechts ga, en er
        // is geen comment, dan wil ik gelijk in de chat belanden", here even
        // in one step since there is nothing to drill into first).
        openGeneralChat()
      } else if (!isPrCommentThreadFocused(sc)) enterPrCommentThread(sc)
    } else enterDiff()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    // Symmetric with the ArrowRight branch above: a FIRST → into an anchored
    // comment only flips state.commentAnchorEntered (revealing the drilled
    // column's diff highlight while the keyboard stays on the sidebar list —
    // see that branch's own doc comment). A ← reached here (relatedActive()
    // already false, i.e. not swallowed by the branch above) must undo that
    // same single step before falling through to enterDescriptionFromList() —
    // otherwise "comment index -> diff -> comment index" via 2x→ would need
    // only 1x← to fully return, landing one stop too far left. Reviewer
    // request: "als ik 2 keer naar rechts ga, wil ik ook 2x naar links moeten
    // komen".
    if (state.commentAnchorEntered) {
      state.commentAnchorEntered = false
      return
    }
    enterDescriptionFromList()
  }
}

window.addEventListener('keydown', onKeydown)

// keyup ends a held c/v resize (see startResizeKey/stopResizeKey above); a
// window-level `blur` is a safety net for the case the keyup itself never
// arrives (e.g. Alt+Tab away while still holding the key) — without it the
// animation would keep running, silently growing/shrinking the column
// forever in the background.
window.addEventListener('keyup', (e) => {
  if (e.key === 'c' || e.key === 'v') stopResizeKey(e.key)
})
window.addEventListener('blur', () => {
  if (activeKeyResize) activeKeyResize.handle.cancel()
  activeKeyResize = null
})

// mouseActiveHints wiring — see the state field's own doc comment above.
// `hintIdleTimer` is a plain module variable (not reactive state) purely for
// bookkeeping; only `state.mouseActiveHints` itself needs to be reactive.
// Guarded by `!state.mouseActiveHints` so a fast mousemove stream (many
// events per second while actually moving) writes the reactive flag at most
// once per idle-to-active transition, never on every pixel of movement.
let hintIdleTimer = null
window.addEventListener(
  'mousemove',
  () => {
    if (!state.mouseActiveHints) state.mouseActiveHints = true
    clearTimeout(hintIdleTimer)
    hintIdleTimer = setTimeout(() => {
      state.mouseActiveHints = false
    }, 5000)
  },
  { passive: true },
)

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
  const groups = unitsOf(curBlock())
  if (!groups.length) return false
  const atEdge = delta > 0 ? state.change >= groups.length - 1 : state.change <= 0
  if (!atEdge && !(delta < 0 && blockDescFocused())) return false
  // Going UP off the first unit reaches the block's description strip first
  // when it has one (see focusBlockDesc), so the chevron would promise the
  // wrong destination: it only appears once the strip itself has the cursor
  // (whereupon ↑ really does leave the block).
  if (delta < 0 && blockDescStopAvailable() && !blockDescFocused()) return false
  return curTestClassRow() ? canStepTestMethod(delta) : sameFileNeighbour(delta)
}

// canStepTestMethod is the non-mutating check behind canStep's grey chevron
// while a test_class row is selected — mirrors stepTestMethod's own edge/
// flow-through logic without moving anything.
function canStepTestMethod(delta) {
  const row = curTestClassRow()
  if (!row) return false
  const next = state.classMethodSel + delta
  if (next >= 0 && next < row.methods.length) return true
  const dir = delta > 0 ? 1 : -1
  let idx = state.selected + dir
  while (idx >= 0 && idx < state.blocks.length && state.blocks[idx].kind !== 'test_class') idx += dir
  return idx >= 0 && idx < state.blocks.length
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

// A look-ahead preview card (the block stacked below/next to the ACTIVE
// selected/focused card, both the top-level one in DetailPanel's pair.forEach
// and the drilled-column one in drillPreviewColumns below) always collapses to
// just its header + meta row via Block()'s own `collapsed` opt — every card
// visible below the active one is deliberately just a small header, never the
// full description + diff body, regardless of how tall the active card is.
// Both call sites pass `collapsed: () => true` straight through (still a
// function, for parity with activeGroup/hintsEnabled/etc., even though it's
// now a constant) rather than `true` directly, so a later reason to make this
// conditional again only needs to change the function body, not Block()'s
// `opts.collapsed` contract itself.

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
  // Whether the currently-focused drilled column's own card — the one this
  // preview is stacked directly under — is one-sided (added/removed). Task 29:
  // mirrors the top-level look-ahead preview's activeSingleSided check, one
  // directional only (never forces a one-sided preview to widen) — this only
  // narrows the preview's WIDTH to match; it no longer guarantees the preview
  // shows no removed content (a genuinely two-sided preview forced into
  // 'unified' still shows its old (-) lines, just narrow and stacked, see
  // "preview matches active width" in detail-layout.md).
  const activeSingleSided = !!singleSide(focusedBlock() || {})
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
          // A click on this look-ahead sibling preview focuses it exactly like
          // running ↓/f off the end of the currently-focused column's own
          // units would (see focusDrillPreviewSibling) — resolved eagerly,
          // right at mousedown, rather than deferred to the next mouseup like
          // every other card: a still-unfocused preview never supports a
          // drag/native-selection range, only the single row clicked.
          onRowMouseDown: (row) => {
            const level = state.focusLevel
            focusDrillPreviewSibling()
            const nb = state.drill[level - 1]
            if (nb) resolveClickSelection({ level, b: nb, i: null, row, segStart: null })
          },
          commentedRows: () => commentRowSet(previewBlock),
          lineSummaries: () => lineChildSummaries(previewBlock),
          viewMode: () => (activeSingleSided ? 'unified' : state.diffViewMode),
          // Always collapse to just the header + meta row — see the "look-ahead
          // preview" note above drillPreviewColumns.
          collapsed: () => true,
          // Caps this preview's own 'fit'-stand width at the focused column's
          // card — the second half of "never wider than active" (see
          // fitCapCharsFor's own doc comment): activeSingleSided above only
          // covers the split/unified stands and a one-sided active card, it
          // does nothing in 'fit' or when both cards are two-sided PHP
          // blocks with a different longest line. Same lazy-closure
          // discipline as collapsed above.
          capFitChars: () => fitCapCharsFor(focusedBlock() || {}, focusedActiveUnit()),
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
// LAST row of the active change unit (`[data-change-active-end]`, Block.mjs)
// if there is one — the same row for a single-line unit, but the bottom of a
// multi-row `group` unit or an extended Shift+up/down range (see rangeUnit),
// so the menu never overlaps the selection it was opened on — else the
// selected block's card, else the sidebar row. `[data-change-active]` (the
// FIRST row) stays reserved for scrollChangeIntoView, which centres on the
// top of the selection, not the menu. Always something on-screen so the menu
// opens under whatever is selected.
// ALSO gated on state.focusLevel <= 1: a child drilled from INSIDE the
// comment anchor's own Underlying-code panel (state.focusLevel > 1, see
// drillIntoChild/openCommentAnchorDrill and the matching ArrowUp/ArrowDown/
// Enter fixes elsewhere in this file) keeps state.mode === 'list' the whole
// time, so without this the 'block'/postApprove palette for THAT drilled
// child still misidentified itself as the plain sidebar case and anchored/
// sized itself against pr-index — which state.commentAnchorEntered keeps
// collapsed to width 0 at any drill depth, not just at the anchor's own
// level 1. The menu then genuinely mounted (its input even took focus) but
// rendered as an unusable ~2px-wide sliver pinned to the far-left edge —
// reported bug: "als ik enter druk, zie ik het menu niet" (confirmed live:
// pr-index box width 0, command-menu box { width: 2, height: 287.75 }).
// Reachable at focusLevel > 1 only through this one comment-anchor flow — an
// ordinary drill always runs inside state.mode === 'diff', which already
// claims Enter/`/` first (see the state.mode === 'diff' branch in onKeydown).
function isIndexMenu() {
  // 'pr' is in this list because `/` now ALWAYS opens the PR menu (see its
  // branch in onKeydown): pressed from the index it must appear next to the
  // index like every other menu opened there, not over the diff region far
  // to the right. Explicitly NOT at stop 1 — this check runs before
  // isDescriptionMenu below and state.mode is 'list' there too, so without
  // the guard the description column's own anchor would never be reached.
  // In diff mode this whole branch is skipped, so the PR menu keeps its
  // default positioning there.
  return (
    state.mode === 'list' &&
    (ms.mode === 'block' || (ms.mode === 'pr' && !state.showDescription) || isReviewFollowup(ms.mode)) &&
    state.focusLevel <= 1
  )
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
  return state.showDescription && (ms.mode === 'pr' || ms.mode === 'checkout')
}

function menuAnchor() {
  // The comment-kind menu ('compose') anchors under the composer textarea.
  if (ms.mode === 'compose') {
    return (
      document.querySelector('[data-testid="comment-compose"]') ||
      document.querySelector('[data-testid="inline-comments"]')
    )
  }
  if (ms.mode === 'comment') {
    return focusedCommentEl() || document.querySelector('[data-testid="inline-comments"]')
  }
  // The publish-choice menu ('replyPublish', opened after a reply on a thread
  // that has never touched GitHub — see pendingPublishInfo/openPublishMenu in
  // RelatedPanel.mjs) reuses the SAME anchor as whichever reply field it was
  // opened from: pendingPublishInfo().kind is 'prwide' for the comment-index
  // detail card's reply field (mirror the 'prComment' branch below), 'thread'
  // for the block-scoped conversation (mirror the 'comment' branch above).
  // This mode used to fall all the way through to the generic diff-row
  // default, which floated the menu over the code being reviewed instead of
  // the comment column it belongs to.
  if (ms.mode === 'replyPublish') {
    if ((pendingPublishInfo() || {}).kind === 'prwide') {
      return document.querySelector('[data-testid="comment-detail-card"]') || focusedColumnEl()
    }
    return focusedCommentEl() || document.querySelector('[data-testid="inline-comments"]')
  }
  // The Claude-column menu ('claude') anchors on the chat card itself — unlike
  // every mode below this, it must NOT fall back to the selected block's diff
  // row: the Claude column can be reached with no diff row on screen at all
  // (comments panel is column-scoped, not diff-scoped), and that fallback
  // chain would otherwise leave the palette permanently un-positioned
  // (positionMenu bails when either anchor or region is null).
  if (ms.mode === 'claude') {
    return (
      document.querySelector('[data-testid="claude-chat-card"]') ||
      document.querySelector('[data-testid="comment-claude-row"]')
    )
  }
  // The comment-index-item menu ('prComment') anchors on its own detail card
  // in the block column, to the right of the index — that card already shows
  // the thread (see commentDetailCard/detail-layout.md), so the menu opens
  // right underneath it instead of over the sidebar row.
  //
  // Falls back to focusedColumnEl(), NOT the bare `[data-testid="block-column"]`
  // selector: while the reviewer opened this exact comment item via
  // openCommentAnchorDrill (its own anchor block drilled open next to it, see
  // that function's own doc comment), state.focusLevel > 0 and the top-level
  // block-column collapses to a narrow rail — commentDetailCard is never
  // rendered in that state at all (DetailPanel's own !focusedHere branch
  // returns the rail before ever reaching the comment-kind row) — so the bare
  // selector still matched an element, just the wrong (56px-wide, rail) one,
  // both mispositioning the menu over the collapsed rail AND clamping it to
  // the rail's own width. focusedColumnEl() resolves to the actual focused
  // drill-column in that case. Bug report: "als ik een onderliggende code open
  // doordat ik een comment open... wil ik dat het menu op de juiste blok
  // zichtbaar is (niet in de parent)".
  if (ms.mode === 'prComment') {
    return document.querySelector('[data-testid="comment-detail-card"]') || focusedColumnEl()
  }
  // Enter from the blokken-index (list mode): anchor on the selected row
  // itself, not the list-mode diff preview beneath it (see
  // .claude/docs/keyboard-navigation.md).
  if (isIndexMenu()) {
    // Stop 2b (the methodes-kolom) owns the keyboard: the pr-index <aside>
    // is collapsed to width 0 then (see BlockList.mjs's testColumnFocused
    // branch), so the generic row/aside lookup below would anchor/size the
    // menu against a genuinely zero-width element — the reported bug ("ik
    // zie geen menu, denk buiten beeld"), reproduced for both a single Enter
    // and a Shift+arrow multi-method selection alike. Anchor on the BOTTOM
    // row of the active method selection instead — the same "anchor on the
    // end of the selection" rule the generic branch below already applies to
    // [data-change-active-end] — falling back to the column itself.
    if (isTestColumnActive()) {
      const hi = state.methodAnchor == null ? state.classMethodSel : Math.max(state.methodAnchor, state.classMethodSel)
      return (
        document.querySelector(`[data-testid="test-methods-column"] [data-idx="${hi}"]`) ||
        document.querySelector('[data-testid="test-methods-column"]')
      )
    }
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
    // The last row of the active unit, so a multi-row selection (group unit
    // or a Shift-extended range) gets the menu below its bottom instead of
    // its top (see the doc comment above) — falls back to the first-row
    // anchor for the unlikely case the end marker is missing.
    document.querySelector('[data-change-active-end]') ||
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
  // The comment-kind menu ('compose') sits over the composer itself; the
  // comment-scoped menu ('comment') sits over the expanded thread pane.
  // Both fall back to the whole inline-comments block if their own element
  // isn't there yet (e.g. still mid-transition).
  if (ms.mode === 'compose') {
    return (
      document.querySelector('[data-testid="comment-composer"]') ||
      document.querySelector('[data-testid="inline-comments"]')
    )
  }
  if (ms.mode === 'comment') {
    return (
      document.querySelector('[data-testid="comment-thread"]') ||
      document.querySelector('[data-testid="inline-comments"]')
    )
  }
  // The publish-choice menu ('replyPublish') mirrors menuAnchor's own
  // 'replyPublish' branch: same region as 'prComment' for a comment-index
  // reply, same region as 'comment' for a block-scoped reply.
  if (ms.mode === 'replyPublish') {
    if ((pendingPublishInfo() || {}).kind === 'prwide') {
      return document.querySelector('[data-testid="comment-detail-card"]') || focusedColumnEl()
    }
    return (
      document.querySelector('[data-testid="comment-thread"]') ||
      document.querySelector('[data-testid="inline-comments"]')
    )
  }
  // The Claude-column menu ('claude') sits over the chat card itself — same
  // "must not fall back to the diff row" reasoning as menuAnchor above.
  if (ms.mode === 'claude') {
    return (
      document.querySelector('[data-testid="claude-chat-card"]') ||
      document.querySelector('[data-testid="comment-claude-row"]')
    )
  }
  // See the matching 'prComment' branch in menuAnchor above for why this
  // falls back to focusedColumnEl() rather than the bare block-column
  // selector (openCommentAnchorDrill's collapsed-rail case).
  if (ms.mode === 'prComment') {
    return document.querySelector('[data-testid="comment-detail-card"]') || focusedColumnEl()
  }
  if (isIndexMenu()) {
    // Same stop-2b exception as menuAnchor above: the methodes-kolom, not
    // the (collapsed, width-0) pr-index, is what the menu should size itself
    // against while it owns the keyboard.
    if (isTestColumnActive()) {
      return document.querySelector('[data-testid="test-methods-column"]')
    }
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
// resize/scroll while open, since the anchor moves with the page. A `native`
// (right-click) menu has no anchor/region at all — see positionNativeMenu.
function positionMenu() {
  if (ms.native) return positionNativeMenu()
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

// positionNativeMenu places the right-click context menu at the exact point
// the reviewer clicked (ms.x/ms.y, set by openMenu), clamped into the
// viewport — mirroring how a real native OS context menu never renders
// partially off-screen. Unlike positionMenu, its width is intrinsic
// (CommandMenu's own `native` sizing, min-w/max-w), never stretched to a
// region's width.
function positionNativeMenu() {
  const box = document.querySelector('[data-testid="command-anchor"]')
  if (!box) return
  box.style.width = 'auto'
  const gap = 4
  const vh = window.innerHeight
  const vw = window.innerWidth
  const mh = box.offsetHeight
  const mw = box.offsetWidth
  const left = Math.max(gap, Math.min(ms.x, vw - mw - gap))
  const top = Math.max(gap, Math.min(ms.y, vh - mh - gap))
  box.style.left = left + 'px'
  box.style.top = top + 'px'
  box.style.visibility = 'visible'
}

// menuOverlay — the command palette (both the searchable keyboard palette and
// the right-click `native` context menu, see CommandMenu's own `native` opt)
// as a floating popover over the whole page. A full-screen catch layer closes
// it on an outside click — deliberately unconditional, including for a
// `native` menu: unlike the removed passive mouse-selection preview, a
// right-click menu DOES own the keyboard (`menu.open`), so dismissing it on
// any outside click matches a real native OS context menu too. The palette
// itself is fixed-positioned by positionMenu (menuAnchor/menuRegion for the
// keyboard palette, ms.x/ms.y for a native one), over everything else. Starts
// hidden until positioned to avoid a top-left flash on the first frame.
function menuOverlay() {
  return html`
    <div class="fixed inset-0 z-40" data-testid="command-overlay" @click="${() => closeMenu()}">
      <div
        class="fixed z-50 max-w-[calc(100vw-1rem)]"
        style="top:0;left:0;visibility:hidden"
        data-testid="command-anchor"
        @click="${(e) => e.stopPropagation()}"
      >
        ${CommandMenu(ms, resolveCommands, runCommand, { native: ms.native })}
      </div>
    </div>
  `
}

// MenuHost mounts the command-palette overlay at the top level (sibling of
// PrInfoPanel/BlockList/DetailPanel), not nested inside <main>. <main> is
// itself `position:fixed` with an explicit z-index (z-10), which makes it a
// stacking-context root: any `fixed`/z-indexed descendant (the overlay was
// z-40/z-50) only stacks *within* <main>'s own subtree — externally the whole
// thing is capped at <main>'s z-10. Mounting the overlay as a separate
// top-level element lets its own z-40/z-50 compete directly at the root
// stacking context instead.
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
  if (d === 'APPROVED') return prPill(t('Goedgekeurd'), 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/30')
  if (d === 'CHANGES_REQUESTED') return prPill(t('Wijzigingen gevraagd'), 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30')
  return prPill(t('Wacht op review'), 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30')
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

// DESC_TRUNCATE_AT is the character length past which the PR description gets
// a "meer…" affordance in the PR-info column. A short body renders in full —
// no misleading toggle. Character-count is deliberate: it's deterministic and
// needs no DOM measurement (no reactive layout read). It only gates whether
// the affordance EXISTS — the collapsed height itself is no longer a fixed
// pixel value but CSS/flex-driven (see pr-info-body below), so it always
// fills whatever room is actually left in the column instead of a fixed,
// often-too-short 160px that left unused space above the status pills.
const DESC_TRUNCATE_AT = 280

// The Jira description box (title + full ticket body, formerly
// data-testid="pr-info-jira", right under the Omschrijving section) is
// deliberately not rendered for now — it overwhelmed the card with a long
// ticket body. The fetch mechanism stays intact (state.prMeta.jiraTitle/
// jiraDesc keep getting set, only nothing reads them here anymore), as does
// the jiraKey pill next to the title (data-testid="pr-info-jira-key",
// a link, not the "explanation").
// SINCE_TRUNCATE_AT is the character length past which ONE since-review block
// collapses to a fixed height with a fade, plus a "meer… (Enter)" affordance.
// Same idea and the same deterministic character count as DESC_TRUNCATE_AT
// above (no DOM measurement, no reactive layout read): it only gates whether
// the affordance EXISTS, so a short block never gets a misleading toggle.
// Reviewer: "je mag het afkappen, maar als ik enter druk op z'n blok dan wil ik
// de volledige omschrijving lezen" — hence a fade in the column plus Enter (or
// a click) on the focused block to read all of it, rather than a taller card.
const SINCE_TRUNCATE_AT = 200

// sinceReviewSections splits "what changed since your last review" into the
// separate, individually navigable blocks the reviewer asked for ("dit blok in
// meerdere blokken verdelen zonder het af te kappen, ik moet met mijn keys naar
// beneden kunnen navigeren"):
//
//  1. The STORY block — the PR overview's own line VERBATIM ("Bijgewerkt …
//     geleden · nieuw sinds jouw review", same shared relativeTime and the same
//     wording as `newSinceMark` in overview.mjs, off literally the same moment
//     the overview marks — inbox.go's myLastActivity, carried here through
//     prmeta rather than recomputed, see .claude/docs/workflows-trackers.md
//     stage 3/4) plus the Haiku explanation, and NOTHING else: on request the
//     facts no longer sit in this block. Its heading is "Aanpassingen sinds
//     jouw review" and the explanation itself now describes only the most
//     recent change (see prompts/since_review.md).
//  2. One block per section of the deterministic fact list (`meta.sinceFacts`):
//     the new commits, and the files they touch.
//
// The split is a plain scan for the `**…**` heading lines sinceReviewFacts
// (workflows.go) emits — never a Dutch word, so a reworded backend keeps
// working, and a fact blob without any such line degrades to ONE block holding
// everything, i.e. exactly the old rendering. Returns [] when there is nothing
// new at all, or when this reviewer never reviewed this PR (`newSinceKind`
// empty): the same silence the overview keeps. `sinceFacts` empty means the
// same, since the backend clears both halves in that case.
//
// The meaning is carried by the WORDS (the headings plus the facts themselves);
// the sky tint is decoration only (colourblind rule). The AI explanation is
// best-effort and simply absent when Haiku didn't produce one — the
// deterministic blocks below it always stand on their own.
function sinceReviewSections(meta) {
  if (!meta || !meta.newSinceKind || !meta.sinceFacts) return []
  const kindWord = meta.newSinceKind === 'review' ? t('nieuw sinds jouw review') : t('nieuw sinds jouw comment')
  const updated = relativeTime(meta.ghUpdatedAt)
  const out = [
    {
      key: 'since:story',
      story: true,
      title: t('Aanpassingen sinds jouw review'),
      line: updated ? t('Bijgewerkt {updated} · {kindWord}', { updated, kindWord }) : kindWord,
      body: (meta.sinceSummary || '').trim(),
    },
  ]
  let cur = null
  for (const raw of String(meta.sinceFacts).split('\n')) {
    const line = raw.trim()
    if (line.startsWith('**')) {
      cur = { key: 'since:facts:' + out.length, title: sinceFactTitle(line), body: '' }
      out.push(cur)
      continue
    }
    if (!cur) {
      if (line === '') continue
      cur = { key: 'since:facts:' + out.length, title: t('Sinds jouw laatste review'), body: '' }
      out.push(cur)
    }
    cur.body += raw + '\n'
  }
  return out.filter((s) => s.story || s.body.trim() !== '')
}

// sinceFactTitle turns a fact section's own heading line ("**4 nieuwe commits**
// sinds jouw laatste review:") into the small-caps block heading the rest of
// the PR-info column already uses (DOEL/WEERGAVE/OMSCHRIJVING): the bold
// markers and the trailing colon go, the words stay verbatim — the count still
// leads, so it reads as a heading without needing bold inside it.
function sinceFactTitle(line) {
  return line.replace(/\*\*/g, '').replace(/:\s*$/, '').trim()
}

// sinceCollapsible / sinceExpanded — is this block long enough to be worth
// collapsing, and is it currently open? Expanded keys live in
// state.sinceExpanded (ephemeral UI state, deliberately not in the URL, like
// state.descriptionExpanded).
function sinceCollapsible(s) {
  return s.body.length > SINCE_TRUNCATE_AT
}

// toggleSinceExpanded is what BOTH Enter on the focused block and a click on it
// run — same function for key and mouse (see .claude/docs/mouse-navigation.md).
// A click also lands the stop-1 cursor on the block it acted on, exactly like
// openTaskRowMenu does for a Taken row. Reassigns the array (never mutates it
// in place) so the reactive bindings reading it re-run.
function toggleSinceExpanded(s, { focus = false } = {}) {
  if (focus && state.showDescription) state.taskFocus = s.key
  if (!sinceCollapsible(s)) return
  const open = state.sinceExpanded.includes(s.key)
  state.sinceExpanded = open ? state.sinceExpanded.filter((k) => k !== s.key) : [...state.sinceExpanded, s.key]
  if (!open) alignStopOneBlockTop(s.key)
}

// focusedSinceSection re-resolves state.taskFocus against the CURRENT sections —
// what Enter acts on. Same key-not-index discipline as focusedTaskRowFromState:
// a section that vanished under a poll simply isn't found and Enter falls
// through to the PR-wide menu.
function focusedSinceSection() {
  if (!state.taskFocus || !state.taskFocus.startsWith('since:')) return null
  return sinceReviewSections(state.prMeta || {}).find((s) => s.key === state.taskFocus) || null
}

// sinceReviewBlocks renders the sections as separate sibling blocks inside the
// PR-info card. A stable `contents` root with the list INSIDE it, per the
// "never key a template whose entire body is one toggling expression" pitfall,
// and the slot always returns an ARRAY (empty when there is nothing new) so it
// never switches between a single element and a keyed list.
function sinceReviewBlocks(state) {
  return html`<div class="contents">${() =>
    sinceReviewSections(state.prMeta || {}).map((s) => sinceReviewBlock(state, s).key(s.key))}</div>`
}

// sinceReviewBlock is one such block: heading, the overview line (story block
// only), and the collapsible body. The focus ring is the same one a focused
// Taken row wears (ring-2 ring-inset ring-indigo-400), so exactly one thing in
// stop 1 ever looks focused — prInfoCard's own ring drops as soon as
// state.taskFocus is set.
function sinceReviewBlock(state, s) {
  const focused = () => state.taskFocus === s.key
  const collapsible = sinceCollapsible(s)
  const open = () => !collapsible || state.sinceExpanded.includes(s.key)
  return html`
    <div
      class="${() =>
        'shrink-0 rounded-lg bg-sky-50 dark:bg-sky-500/15 p-2.5 ' +
        (focused() ? 'ring-2 ring-inset ring-indigo-400 dark:ring-indigo-500' : '')}"
      data-testid="${s.story ? 'pr-info-since-review' : 'pr-info-since-block'}"
      data-stop-one-key="${s.key}"
      data-since-focused="${() => (focused() ? 'true' : 'false')}"
      data-since-collapsed="${() => (collapsible && !open() ? 'true' : 'false')}"
      @click="${() => toggleSinceExpanded(s, { focus: true })}"
    >
      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">${s.title}</div>
      ${() =>
        s.story
          ? html`<div class="mb-1.5 text-[12px] font-medium text-slate-600 dark:text-zinc-300" data-testid="pr-info-since-line">
              ${s.line}
            </div>`
          : ''}
      ${() =>
        s.body
          ? html`<div class="relative">
              <div
                class="${() =>
                  'markdown-body leading-relaxed ' +
                  (s.story ? 'text-[13px] text-slate-700 dark:text-zinc-300 ' : 'text-[12.5px] text-slate-600 dark:text-zinc-400 ') +
                  (open() ? '' : 'max-h-[4.5rem] overflow-hidden code-fence-fade-bottom')}"
                data-testid="${s.story ? 'pr-info-since-summary' : 'pr-info-since-facts'}"
                .innerHTML="${() => renderMarkdown(s.body)}"
              ></div>
              ${() =>
                collapsible
                  ? html`<button
                      type="button"
                      data-testid="pr-info-since-toggle"
                      @click="${(e) => {
                        // stopPropagation FIRST, before the state mutation that
                        // re-renders this button's own ancestor — see the
                        // nested-@click rule in arrowjs-pitfalls.md. Without it
                        // the block's own @click would toggle it straight back.
                        if (e && e.stopPropagation) e.stopPropagation()
                        toggleSinceExpanded(s, { focus: true })
                      }}"
                      class="mt-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      ${() => (open() ? t('Inklappen') : t('meer… (Enter)'))}
                    </button>`
                  : ''}
            </div>`
          : ''}
    </div>
  `
}
// prMenuButton — the mouse entry point into the PR-wide command palette
// (PR_COMMANDS): "PR keuren"/"Algemene comment plaatsen"/the Jira submenu/
// "Alle goedkeuringen intrekken" — same openMenu('pr') the '/'-key and Enter
// (at stop 1) already run, see command-palette.md. A distinct shield-check
// icon (not the block card's kebab, not a comment/chat icon) so all four new
// menu buttons stay visually told apart. Sits in the existing
// pr-info-theme-row, next to the theme/auto-warn toggles, rather than a new
// row of its own.
function prMenuButton() {
  return html`
    <button
      type="button"
      title="${t('PR-menu (keuren, comment plaatsen, Jira, …)')}"
      data-testid="pr-menu-button"
      class="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-50 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 ring-1 ring-slate-200 dark:ring-zinc-700 hover:text-indigo-600 dark:hover:text-indigo-400"
      @click="${() => openMenu('pr')}"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true">
        <path d="M8 1.5l5 2v3.8c0 3.3-2.1 5.7-5 7.2-2.9-1.5-5-3.9-5-7.2V3.5l5-2z"></path>
        <path d="M5.7 8l1.6 1.6L10.3 6"></path>
      </svg>
    </button>
  `
}

// checkoutFolderGlyph/checkoutAlertGlyph — the two chip glyphs
// (checkoutChip below), 24x24 outline SVGs matching prMenuButton's own
// inline-SVG convention in this file (no shared icon registry here, unlike
// overview.mjs). Per the colourblind rule the SHAPE (folder vs. triangle)
// plus the label word carry the meaning — colour is pure decoration.
function checkoutFolderGlyph() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3" aria-hidden="true">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>
  </svg>`
}
function checkoutAlertGlyph() {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3" aria-hidden="true">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
    <path d="M12 9v4"></path>
    <path d="M12 17h.01"></path>
  </svg>`
}

// checkoutChipLabel/-Title/-Cls: word + glyph carry the state (see the
// colourblind rule) — "Geen directory" before anything ever loaded/resolved,
// "Keuze nodig" while chat_checkout.go has a pending chatCheckoutDecision,
// otherwise the assigned directory's own last path segment.
function checkoutChipLabel() {
  const c = state.checkout
  if (!c) return t('Geen werkmap')
  if (c.decision) return t('Keuze nodig')
  if (c.dirName) return c.dirName
  return t('Geen werkmap')
}
function checkoutChipTitle() {
  const c = state.checkout
  if (!c) return t('Werkmap voor Claude-aanpassingen: nog niet geladen')
  if (c.decision) return c.decision.body || t('Er moet iets over de werkmap worden besloten')
  if (c.dir) return c.branch ? t('Claude werkt in {dir} (branch {branch})', { dir: c.dir, branch: c.branch }) : t('Claude werkt in {dir}', { dir: c.dir })
  return t('Geen werkmap gekoppeld — klik om een werkmap te kiezen')
}
function checkoutChipCls() {
  const c = state.checkout
  const base =
    'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors '
  if (c && c.decision) {
    return base + 'text-amber-700 dark:text-amber-400 ring-amber-300 dark:ring-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10'
  }
  if (c && c.dirName) {
    return base + 'text-sky-700 dark:text-sky-400 ring-sky-200 dark:ring-sky-500/30 hover:bg-sky-50 dark:hover:bg-sky-500/10'
  }
  return base + 'text-slate-500 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800'
}

// checkoutChip — the chip next to autoWarnToggleButton/themeToggleButton in
// prInfoCard's pr-info-theme-row: which local checkout (if any) a
// claude_chat write turn edits directly for this PR (chat_checkout.go).
// Click opens checkoutChipCommandsFor() through the same small command-menu
// mechanism prMenuButton/autoWarnToggleButton's row already sits in (mode
// 'checkout', anchored on pr-info-card via isDescriptionMenu — see
// menuAnchor/menuRegion). The glyph toggle sits behind a STABLE element root
// (never a bare `${() => cond ? A : B}` as a template's entire body) per the
// arrow.js pitfall of a keyed/toggling template corrupting a neighbouring
// binding — see .claude/rules/arrowjs-pitfalls.md, stepChevronSlot's own fix.
// testRunStatusLine — the one status line for a running/just-finished test
// run, mirroring claudeStatusText's own phase/tool wording (ClaudeChat.mjs) so
// the reviewer reads the same vocabulary everywhere Claude is doing agentic
// work. Word carries the meaning, never a colour alone (colourblind rule).
function testRunStatusLine() {
  if (testRun.error) return t('Kon geen tests draaien: {error}', { error: testRun.error })
  if (testRun.cancelled) return t('Afgebroken op jouw verzoek.')
  if (testRun.running) return claudeStatusText({ running: true, phase: testRun.phase, tool: testRun.tool, detail: testRun.detail }, 0)
  return t('Klaar — {passed} geslaagd, {failed} mislukt.', { passed: testRun.passed, failed: testRun.failed })
}

// testRunStatusBlock — the PR-wide "Tests laten draaien" status card in
// prInfoCard, below the ordinary GitHub status pills. Only rendered at all
// while hasTestRunActivity() (testRun.mjs) — the card never occupies space
// for a PR that never ran a test_run. A dedicated bottom action row was
// deliberately rejected (reviewer decision: the sidebar is busy enough) —
// this is a `/`-menu action (PR_COMMANDS' "Tests laten draaien") instead, and
// its progress renders here, next to the other PR-wide status/toggle rows.
function testRunStatusBlock() {
  return html`
    <div
      class="mt-2 shrink-0 rounded-lg bg-slate-50 dark:bg-zinc-800/60 ring-1 ring-slate-200 dark:ring-zinc-700 p-2.5"
      data-testid="test-run-status"
    >
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">Tests</span>
        <span class="contents">${() =>
          testRun.running
            ? html`<button
                type="button"
                data-testid="test-run-stop"
                title="${t('Stop deze testrun')}"
                class="rounded px-1.5 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                @click="${() => cancelTestRun(state.pr)}"
              >
                Stop
              </button>`
            : ''}</span>
      </div>
      ${() => (testRun.plan ? html`<p class="mb-1 text-[12px] italic text-slate-500 dark:text-zinc-400">${testRun.plan}</p>` : '')}
      <p class="text-[12.5px] text-slate-700 dark:text-zinc-300" data-testid="test-run-status-line">${() => testRunStatusLine()}</p>
      ${() =>
        testRun.items.length
          ? html`<ul class="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto text-[12px]" data-testid="test-run-items">
              ${testRun.items.map(
                (it) =>
                  html`<li class="flex items-center gap-1.5" data-testid="test-run-item">
                    <span
                      class="${'shrink-0 font-medium ' +
                      (it.state === 'pass'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : it.state === 'fail'
                          ? 'text-rose-600 dark:text-rose-400'
                          : it.state === 'interrupted'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-sky-600 dark:text-sky-400')}"
                      >${TEST_RUN_STATE_LABEL[it.state] || it.state}</span
                    >
                    <span class="truncate text-slate-600 dark:text-zinc-400" title="${it.name}">${it.name}</span>
                    ${it.note ? html`<span class="truncate text-slate-400 dark:text-zinc-500">— ${it.note}</span>` : ''}
                  </li>`.key(it.name),
              )}
            </ul>`
          : ''}
    </div>
  `
}

function checkoutChip() {
  return html`
    <button
      type="button"
      data-testid="checkout-chip"
      title="${() => checkoutChipTitle()}"
      class="${() => checkoutChipCls()}"
      @click="${() => openMenu('checkout')}"
    >
      <span class="contents">${() => (state.checkout && state.checkout.decision ? checkoutAlertGlyph() : checkoutFolderGlyph())}</span>
      <span>${() => checkoutChipLabel()}</span>
    </button>
  `
}

// prInfoCard is built in two layers: everything readable scrolls inside
// `pr-info-scroll` (which owns the card's `overflow-auto` + `gap-3`), and the
// status pills sit BELOW that scroller as a fixed card footer
// (`pr-info-statuses`, a `shrink-0` row behind a `border-t`). They used to be
// the last child inside the scroller with `mt-auto`, which is how a
// squeezed-flat `pr-info-body` could paint its text straight over them
// (reviewer: "die extra gegeven, labels enzo, laat dat als een footer van dat
// blok zien, dingen moeten niet over elkaar heen"). Being outside the scroller
// also keeps them in view while the reviewer reads/scrolls the blocks above.
function prInfoCard(state) {
  return html`
    <div
      class="${() =>
        // No `overflow-auto`/`gap-3` here any more: those moved to the inner
        // pr-info-scroll area below, so the status pills can sit OUTSIDE the
        // scroller as a real card footer (see prInfoStatusFooter).
        'flex min-h-0 flex-col rounded-2xl border bg-white dark:bg-zinc-900 p-5 shadow-sm ' +
        // PR-wide comments no longer have their own card here — they're
        // navigable "Start" sidebar items instead, see recomputeLeftList/
        // commentBlockItem and detail-layout.md. The Tasks block (TasksPanel,
        // see PrInfoPanel below) is a shrink-0 sibling stacked below this
        // card in the same pr-info-column, so this card takes whatever's
        // left of the column's height instead of always the full height.
        'flex-1 ' +
        // Light-blue border while the keyboard drives stop 1 (this panel is only
        // ever mounted while showDescription is true, but read it here anyway so
        // the binding stays reactive) — mirrors diffActive on the block-diff card.
        // `!state.taskFocus`: ↓ can move the cursor down into the "Taken" block
        // below without leaving stop 1, and exactly one of the two may look
        // focused at a time (see stepTaskFocus).
        (state.showDescription && !state.taskFocus
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5')}"
      data-testid="pr-info-card"
      @contextmenu="${(e) => {
        // Right-click anywhere on the PR-description card = the same click
        // pr-menu-button already runs, just native-styled and positioned at
        // the cursor — no landing step needed, this card only ever renders
        // while it already owns the keyboard (state.showDescription). See
        // "The right-click context menu" in command-palette.md.
        if (isEditableFocused()) return
        e.preventDefault()
        openMenu('pr', { native: true, x: e.clientX, y: e.clientY })
      }}"
    >
      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto" data-testid="pr-info-scroll">
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
        ${() => (state.prMeta.changedFiles ? html`<span>${t('{n} bestanden', { n: state.prMeta.changedFiles })}</span>` : '')}
        ${() => (state.prMeta.headRef ? html`<span class="text-slate-300 dark:text-zinc-600">·</span>` : '')}
        ${() =>
          state.prMeta.headRef
            ? html`<span class="truncate font-mono text-sky-600 dark:text-sky-400" title="${t('Huidige branch')}">${state.prMeta.headRef}</span>`
            : ''}
        ${() => (state.prUrl ? html`<span class="text-slate-300 dark:text-zinc-600">·</span>` : '')}
        ${() =>
          state.prUrl
            ? html`<a href="${state.prUrl}" target="_blank" rel="noreferrer" class="text-indigo-600 dark:text-indigo-400 hover:underline"
                >${t('op GitHub ›')}</a
              >`
            : ''}
      </div>
      <div class="flex items-center justify-between" data-testid="pr-info-theme-row">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">${t('Weergave')}</span>
        <div class="flex items-center gap-1.5">
          ${prMenuButton()}
          ${autoWarnToggleButton()}
          ${checkoutChip()}
          ${themeToggleButton('h-7 w-7 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}
          ${settingsButton('h-7 w-7 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}
        </div>
      </div>
      <div class="rounded-lg bg-emerald-50 dark:bg-emerald-500/15 p-2.5" data-testid="pr-info-summary">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">${t('Doel')}</div>
        ${() =>
          state.prMeta.summary
            ? html`<div
                class="markdown-body text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300"
                .innerHTML="${() => renderMarkdown(state.prMeta.summary)}"
              ></div>`
            : html`<p class="text-[13px] italic text-slate-400 dark:text-zinc-500">${t('samenvatting genereren…')}</p>`}
      </div>
      ${sinceReviewBlocks(state)}
      <div
        class="${() =>
          // `min-h-[6.5rem]` + `overflow-hidden`, never `min-h-0`: `flex-1`
          // below means `flex: 1 1 0%`, so with a card whose content ALREADY
          // overflows (Doel + three since blocks + an expanded commit list)
          // there is no leftover space to fill and the block was squeezed to a
          // ~40px sliver — while pr-info-body-wrap's own `min-h-[4rem]` floor
          // kept painting its text straight over the status pills below
          // (reported: "dingen moeten niet over elkaar heen"). The floor is
          // that inner 4rem plus this block's own padding and heading; the
          // clip makes overlap structurally impossible either way.
          'flex min-h-[6.5rem] flex-col overflow-hidden rounded-lg p-2.5 ' +
          // Only claim the card's leftover vertical space while there's
          // actually something being collapsed — a short/empty body, or an
          // already-expanded long one, stays at its natural content height
          // (unchanged from before), so it never steals room from the Jira
          // box/pills that isn't needed. See DESC_TRUNCATE_AT above.
          // …and `shrink-0` the rest of the time, so an EXPANDED body really
          // claims its natural height and the card scrolls (which is what the
          // comment above always claimed): as a plain flex item with min-h-0 it
          // was squeezed to ~20px and its text painted straight over the status
          // pills below it. Surfaced by making this block a keyboard stop —
          // reaching it with ↓ and pressing Enter is now the normal way to read
          // it in full.
          (state.prMeta.body && state.prMeta.body.length > DESC_TRUNCATE_AT && !state.descriptionExpanded ? 'flex-1 ' : 'shrink-0 ') +
          // The same focus ring a since block / a Taken row wears while the
          // stop-1 cursor is on it — prInfoCard's own ring drops as soon as
          // state.taskFocus is set, so exactly one thing looks focused.
          (state.taskFocus === DESC_FOCUS_KEY ? 'ring-2 ring-inset ring-indigo-400 dark:ring-indigo-500' : '')}"
        data-testid="pr-info-body"
        data-stop-one-key="${DESC_FOCUS_KEY}"
        data-desc-focused="${() => (state.taskFocus === DESC_FOCUS_KEY ? 'true' : 'false')}"
        @click="${() => toggleDescriptionExpanded({ focus: true })}"
      >
        <div class="mb-1 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">${t('Omschrijving')}</div>
        ${() =>
          state.prMeta.body
            ? state.prMeta.body.length > DESC_TRUNCATE_AT
              ? // Long body: truncate with a fade + clickable "meer…" affordance
                // that toggles state.descriptionExpanded (same flag the PR-menu
                // item drives). Collapsed, the wrap grows (flex-1) to fill
                // whatever's left of the column instead of a fixed pixel
                // height — min-h-[4rem] is a floor so an oversized Jira
                // description below it (shrink-0, unbounded) can't squeeze it
                // away entirely. Expanded, it reverts to natural sizing (the
                // card itself scrolls, as before). The class strings are
                // whole-value function bindings (no partial interpolation —
                // see the arrow.js class-binding pitfall in conventions.md).
                html`<div
                  class="${() => 'relative ' + (state.descriptionExpanded ? '' : 'min-h-[4rem] flex-1')}"
                  data-testid="pr-info-body-wrap"
                >
                  <div
                    class="${() =>
                      'markdown-body text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300 ' +
                      (state.descriptionExpanded ? '' : 'h-full overflow-hidden')}"
                    .innerHTML="${() => renderMarkdown(state.prMeta.body)}"
                  ></div>
                  <button
                    type="button"
                    data-testid="pr-info-body-toggle"
                    @click="${(e) => {
                      // stopPropagation FIRST, before the state mutation that
                      // re-renders this button's own ancestor — see the
                      // nested-@click rule in arrowjs-pitfalls.md. Without it
                      // the block's own @click toggles it straight back.
                      if (e && e.stopPropagation) e.stopPropagation()
                      toggleDescriptionExpanded({ focus: true })
                    }}"
                    class="${() =>
                      state.descriptionExpanded
                        ? 'mt-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline'
                        : 'absolute inset-x-0 bottom-0 flex h-10 cursor-pointer items-end justify-center bg-gradient-to-t from-white via-white/85 to-transparent text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:from-zinc-900 dark:via-zinc-900/85 dark:text-indigo-400 dark:hover:text-indigo-300'}"
                  >
                    ${() => (state.descriptionExpanded ? t('Inklappen') : t('meer…'))}
                  </button>
                </div>`
              : html`<div
                  class="shrink-0 markdown-body text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300"
                  .innerHTML="${() => renderMarkdown(state.prMeta.body)}"
                ></div>`
            : html`<p class="shrink-0 text-[13px] text-slate-400 dark:text-zinc-500">${t('geen omschrijving')}</p>`}
      </div>
      </div>
      <div
        class="mt-3 flex shrink-0 flex-wrap items-center gap-1.5 border-t border-slate-200 dark:border-zinc-800 pt-2.5"
        data-testid="pr-info-statuses"
      >
        ${() => prStatusSlot(state.prMeta)}
      </div>
      <div class="contents">${() => (hasTestRunActivity() ? testRunStatusBlock() : '')}</div>
    </div>
  `
}

// refreshTasks re-reads BOTH sources behind the merged "Taken" block — the
// workflow runs (2.5s poll) and the problems list (15s poll) — on the
// reviewer's own request, via the card's ⟳ button and its row menu. Without it
// the result of a retry could sit invisible for up to 15 seconds.
// setTasksRefreshBusy drives the button's own disabled/busy look.
async function refreshTasks() {
  setTasksRefreshBusy(true)
  try {
    await Promise.all([pollWorkflows(), pollProblems()])
  } finally {
    setTasksRefreshBusy(false)
  }
}

// retryFailedRun starts the failed run's own Workflow Type over with its stored
// input (POST /api/workflows/retry — a workflow START, the sanctioned write
// path, see .claude/rules/workflows-write-boundary.md). Only offered for a run
// the backend itself marked `retryable` (see retryableWorkflow in
// run_errors.go), so the failure branch here is a genuine surprise, not the
// normal "can't retry this kind" case.
//
// markTaskRetrying runs FIRST, before the request is even sent: the retry is a
// NEW Execution, so the failed row itself only disappears once /api/problems
// has seen the failure superseded — up to a poll away, during which the row
// would otherwise look exactly as it did before the click ("ik wil gelijk zien
// dat het weer aan het draaien is"). The mark flips it to "↻ opnieuw gestart"
// in the same tick and needs no cleanup: the row goes away with the failure.
// Only a failed POST clears it again, so the row honestly returns to "mislukt".
// Error handling otherwise follows submitReview's: no toast convention in this
// app, so it logs.
async function retryFailedRun(runId) {
  if (!runId) return
  markTaskRetrying(runId)
  // The row's key encodes its state ('failed:' → 'retrying:'), so the keyboard
  // cursor has to move along with it or the focus ring would drop off the very
  // row the reviewer just acted on.
  if (state.taskFocus === 'failed:' + runId) state.taskFocus = 'retrying:' + runId
  try {
    const res = await fetch('/api/workflows/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    })
    if (!res.ok) {
      clearTaskRetrying(runId)
      console.error('retry failed:', res.status, await res.text())
    }
  } catch (err) {
    clearTaskRetrying(runId)
    console.error('retry failed:', err)
  }
  await refreshTasks()
}

// stepTaskFocus — ↓/↑ while stop 1 owns the keyboard (reviewer: "ik wil met mijn
// down key naar beneden en daar kunnen navigeren … en naar boven terug naar pr
// description"). ↓ from the description card walks into the "Taken" list, then
// row by row; ↑ walks back up and, from the first row, RELEASES the focus back
// to the description card (`taskFocus = ''`) rather than getting stuck.
//
// The cursor is the row's key, so it is re-resolved against the CURRENT list on
// every step: a row that disappeared under a poll simply leaves index -1, and ↓
// then starts at the top again instead of landing somewhere arbitrary.
// Returns false when there is nothing to walk into at all (no rows), so the
// caller can leave the keypress a plain no-op, exactly as it was before.
function stepTaskFocus(dir) {
  const rows = buildStopOneRows(state)
  if (rows.length === 0) {
    state.taskFocus = ''
    return false
  }
  const at = rows.findIndex((r) => r.key === state.taskFocus)
  if (at < 0) {
    // Not in the list yet: ↓ enters at the top, ↑ from the description does
    // nothing (there is nothing above stop 1's own card).
    if (dir < 0) return false
    state.taskFocus = rows[0].key
    scrollStopOneRowIntoView(rows[0].key)
    return true
  }
  const next = at + dir
  if (next < 0) {
    state.taskFocus = '' // back out to the PR description itself
    return true
  }
  if (next >= rows.length) return true // already on the last row: stay put
  state.taskFocus = rows[next].key
  scrollStopOneRowIntoView(rows[next].key)
  return true
}

// DESC_FOCUS_KEY is the stop-1 cursor key of the "Omschrijving" block. A
// constant, because three places have to agree on it (buildStopOneRows, the
// block's own focus binding and the Enter branch).
const DESC_FOCUS_KEY = 'desc:body'

// buildStopOneRows — everything the stop-1 cursor (state.taskFocus) can land
// on, in the order they sit on screen: the "Aanpassingen sinds jouw review"
// blocks (see sinceReviewSections), then the "Omschrijving" block, then the
// merged "Taken" rows below the card. One flat list, so stepTaskFocus needs no
// special cases and a key is re-resolved against the CURRENT list on every step
// (see "Snapshot a selection by stable ID" in .claude/rules/conventions.md).
//
// Reaching those in-card blocks by keyboard is the whole point of this list:
// the card scrolls, and with the since blocks above it the description sat
// below its bottom edge with no way to get there ("ik kan niet naar
// omschrijving"). A PR without a description contributes no stop, exactly like
// an empty fact section.
function buildStopOneRows(state) {
  const since = sinceReviewSections(state.prMeta || {}).map((s) => ({ key: s.key, since: true }))
  const desc = (state.prMeta || {}).body ? [{ key: DESC_FOCUS_KEY, desc: true }] : []
  return since.concat(desc, buildTaskRows(state))
}

// descCollapsible — is the description long enough to have something to open?
// Same deterministic character count that decides whether the "meer…"
// affordance exists at all (DESC_TRUNCATE_AT), so Enter and the affordance can
// never disagree.
function descCollapsible(state) {
  const body = (state.prMeta || {}).body || ''
  return body.length > DESC_TRUNCATE_AT
}

// toggleDescriptionExpanded is what BOTH Enter on the focused Omschrijving
// block and a click on it run — same function for key and mouse, see
// .claude/docs/mouse-navigation.md. A click also lands the stop-1 cursor on the
// block, exactly like a since block or a Taken row.
function toggleDescriptionExpanded({ focus = false } = {}) {
  if (focus && state.showDescription) state.taskFocus = DESC_FOCUS_KEY
  if (!descCollapsible(state)) return
  state.descriptionExpanded = !state.descriptionExpanded
  if (state.descriptionExpanded) alignStopOneBlockTop(DESC_FOCUS_KEY)
}

// scrollStopOneRowIntoView scrolls whichever kind of stop-1 row just took the
// cursor into view — a block inside the PR-info card, or a Taken row.
function scrollStopOneRowIntoView(key) {
  if (String(key).startsWith('since:') || key === DESC_FOCUS_KEY) return scrollCardBlockIntoView(key)
  return scrollTaskRowIntoView(key)
}

// scrollCardBlockIntoView keeps the focused block (a since-review block or the
// Omschrijving block, both carrying data-stop-one-key) inside the scrolling
// PR-info card. scrollIntoViewVertical, never bare scrollIntoView — this card
// sits inside <main>'s horizontally scrolling column flow, see the axis rule in
// .claude/rules/arrowjs-pitfalls.md.
function scrollCardBlockIntoView(key) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-stop-one-key="${key}"]`)
    if (el) scrollIntoViewVertical(el)
  })
}

// alignStopOneBlockTop brings a block the reviewer JUST opened up to the top of
// the scrolling card, so a long text reads from its first line instead of
// staying half below the card's bottom edge. alignToTopVertical, not
// scrollIntoViewVertical: the latter aligns the BOTTOM of an overflowing block,
// which would push the first line out of sight — the opposite of what pressing
// Enter on it was for. Only on opening; collapsing leaves the scroll alone.
function alignStopOneBlockTop(key) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-stop-one-key="${key}"]`)
    if (el) alignToTopVertical(el)
  })
}

// scrollTaskRowIntoView keeps the focused row visible inside the block's own
// 3,5-row window. scrollIntoViewVertical (never bare scrollIntoView) because
// this list sits inside <main>'s horizontally scrolling column flow — see the
// scrollIntoView axis rule in .claude/rules/arrowjs-pitfalls.md. One frame
// later, so the row's focus class/ring is already on the node being scrolled.
function scrollTaskRowIntoView(key) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-testid=workflow-row][data-task-key="${key}"]`)
    if (el) scrollIntoViewVertical(el)
  })
}

// focusedTaskRowFromState re-resolves state.taskFocus against the current list —
// what Enter acts on, and how the row menu is opened without a mouse.
function focusedTaskRowFromState() {
  if (!state.taskFocus) return null
  return buildTaskRows(state).find((r) => r.key === state.taskFocus) || null
}

// focusedTaskRow — the merged "Taken" row the reviewer just clicked, snapshotted
// as a PLAIN (non-reactive) value at click time, exactly like every other
// menu-mode's own live-state read (see resolveLabel/snapshotCommands): the
// command list is built once from it in openMenu and nothing that reads global
// state ever reaches CommandMenu's never-disposed reactive tree.
let focusedTaskRow = null

// openTaskRowMenu is what a click on ANY row in the Taken block runs (reviewer:
// "ook ik moet het aan kunnen klikken, met een menu om het opnieuw te
// proberen"). It opens the native/context-menu variant at the cursor — the same
// shape a right-click uses elsewhere (see "The right-click context menu" in
// command-palette.md) — because the row itself is the anchor the reviewer is
// pointing at. stopPropagation FIRST, before the state mutation that opens the
// menu (see the nested-@click rule in arrowjs-pitfalls.md).
function openTaskRowMenu(row, e) {
  if (e && e.stopPropagation) e.stopPropagation()
  focusedTaskRow = row
  // A click lands the keyboard cursor on the row it acted on, so ↓/↑ continue
  // from there — the same "a click runs what a key runs" rule as every other
  // surface (see .claude/docs/mouse-navigation.md). Only while stop 1 actually
  // owns the keyboard: the column can also be merely pinned open next to a diff
  // (state.descriptionPinned), where a focus ring would point at a cursor that
  // isn't there.
  if (state.showDescription && row) state.taskFocus = row.key
  // A keyboard open (Enter on the focused row) passes no event, so anchor the
  // box on that row's own rect instead of a mouse position — the row IS the
  // anchor either way.
  const at = e && typeof e.clientX === 'number' ? { x: e.clientX, y: e.clientY } : taskRowAnchor(row)
  openMenu('task', { native: true, x: at.x, y: at.y })
}

// taskRowAnchor — where a keyboard-opened row menu appears: just under the
// focused row's left edge, the same "point at the thing you acted on" idea as
// the mouse position for a click. Falls back to the origin if the row somehow
// isn't in the DOM (openMenu clamps the box into the viewport itself).
function taskRowAnchor(row) {
  const el = row && document.querySelector(`[data-testid=workflow-row][data-task-key="${row.key}"]`)
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  return { x: r.left + 24, y: r.bottom }
}

// taskCommandsFor builds the clicked row's menu (openMenu('task'), plain
// non-reactive code — see rootCommandsFor). What a row offers follows strictly
// from what it IS:
//
//   - a failed run whose type can be started over → "Opnieuw proberen" (gone
//     while that retry is still in flight — the row already says "↻ opnieuw
//     gestart", and a second start would queue a second Execution);
//   - a failed run with a per-item Run ID (a comment thread, a chat, …) → the
//     honest "kan niet opnieuw" line instead, since starting it again is a
//     no-op that returns the very same failed run (see retryableWorkflow);
//   - a run linked to a comment → "Open de comment" (openTask), which used to
//     be the row's whole click behaviour;
//   - a mirrored log line → "Verberg deze melding" (this tab only, see
//     hideTaskLogLine);
//   - anything with an error message → "Kopieer foutmelding".
//
// "Verversen" closes the list, so a row that offers nothing else still does
// something useful. Wording note: the retry item is "Opnieuw proberen" and the
// refresh one is the short "Verversen" — two long, similar-looking items read
// as the same action twice (reviewer feedback on "Taken verversen").
function taskCommandsFor() {
  const row = focusedTaskRow
  if (!row) return withClose([])
  const items = []
  if (row.comment) {
    items.push({ id: 'task-open-comment', label: t('Open de comment'), hint: 'open comment', run: () => openTask(row.run) })
  }
  if (row.problem && row.kind === 'run' && !row.retrying) {
    if (row.retryable) {
      items.push({ id: 'task-retry', label: t('Opnieuw proberen'), hint: 'opnieuw retry', run: () => retryFailedRun(row.runId) })
    } else {
      items.push({
        id: 'task-retry-blocked',
        label: t('Kan niet opnieuw proberen — deze taak start alleen bij de bron'),
        hint: 'opnieuw retry',
        run: () => {},
      })
    }
  }
  if (row.error) {
    items.push({ id: 'task-copy-error', label: t('Kopieer foutmelding'), hint: 'copy kopieer', run: () => copyReviewSummary(row.error) })
  }
  if (row.kind === 'log') {
    items.push({ id: 'task-hide-log', label: t('Verberg deze melding'), hint: 'verberg', run: () => hideTaskLogLine(row.key) })
  }
  // "Verversen", not "Taken verversen": next to "Opnieuw proberen" a second
  // long item read as the same action twice (reviewer feedback). The ⟳ button
  // in the card header does exactly this too — the item exists so a row that
  // offers nothing else still does something useful.
  items.push({ id: 'task-refresh', label: t('Verversen'), hint: 'refresh verversen', run: () => refreshTasks() })
  return withClose(items)
}

// PrInfoPanel — stop 1 of the left→right nav chain: the PR-description
// column. A flex sibling of BlockList's <aside> and DetailPanel's <main>
// (mounted together inside AppColumns, below), in that DOM order — so
// opening it simply pushes <aside>/<main> right via ordinary flex reflow, no
// translate-x/left-offset arithmetic needed anywhere. See "Columns instead of
// independently fixed panels" in detail-layout.md.
// Width is 1.5x the original 26rem (w-[39rem]) — the reviewer wanted more
// room to read the PR title/summary/description/Jira box without truncation.
// TasksPanel (RelatedPanel.mjs) used to live in a fixed right-hand sidebar
// (CommentsSidebar, toggled with Cmd+→); it now sits here instead, stacked
// below prInfoCard in the same PR-description column (stop 1 of the nav
// chain) — only shows runs that are genuinely in progress or that have been
// sitting idle for a while (see visibleWorkflowRuns' 5-minute filter).
// A stable "contents" root (see the bare-toggling-expression pitfall in
// arrowjs-pitfalls.md) so this slot can freely switch between the real column
// and nothing: closed, it collapses to zero width and claims no flex slot in
// the row below (AppColumns); open, the inner div itself IS the flex item
// (shrink-0 + an explicit width — no more fixed left-6/top-6/bottom-6 of its
// own, now that PrInfoPanel/<aside>/<main> are real siblings in one flex row).
function PrInfoPanel(state) {
  return html`
    <div class="contents">
      ${() =>
        // showDescription = stop 1 owns the keyboard; descriptionPinned = a
        // mouse click moved the keyboard into a diff but the column still fits
        // beside it, so there was no reason to take it away (see
        // applyDiffColumnFit). Visibility is the OR of the two; every keyboard
        // branch in onKeydown keeps reading showDescription alone.
        state.showDescription || state.descriptionPinned
          ? html`<div
              class="flex h-full min-h-0 w-[39rem] shrink-0 flex-col gap-3"
              data-testid="pr-info-column"
            >
              ${prInfoCard(state)}
              ${TasksPanel(state, { openRowMenu: openTaskRowMenu, refresh: refreshTasks, focusState: state })}
            </div>`.key('pr-info-column')
          : ''}
    </div>
  `
}

// testClassPreviewCard is the DIMMED look-ahead preview of a test_class row
// (see testClassRowItem/recomputeLeftList) that sits one below the current
// selection — a compact summary (class name + the same methods-only approve
// pill the sidebar row itself shows, see blockApproveCount's test_class
// branch) instead of the full, interactive TestMethodsColumn — the full
// column only ever renders for the row that's ACTUALLY selected (decision:
// "zodra een class-rij geselecteerd is"). Mirrors commentDetailCard's own
// preview variant for a comment-index item.
function testClassPreviewCard(state, row) {
  const s = state.approvalSummaries && state.approvalSummaries[row.id]
  return html`
    <div class="contents" data-testid="detail-card">
      <div
        class="flex min-h-0 w-64 shrink-0 flex-col gap-1 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/60 px-3 py-2 opacity-60"
        data-testid="test-class-preview"
      >
        <div class="flex items-center gap-2">
          <span class="shrink-0 rounded bg-slate-200 dark:bg-zinc-700 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:text-zinc-400"
            >TEST</span
          >
          <span class="truncate text-sm font-medium text-slate-700 dark:text-zinc-300">${row.label}</span>
        </div>
        <p class="text-xs text-slate-400 dark:text-zinc-500">
          ${row.methods.length} ${t(row.methods.length === 1 ? 'methode' : 'methodes')}${s && s.total
            ? ` · ${s.done}/${s.total}`
            : ''}
        </p>
      </div>
    </div>
  `
}

// DetailPanel — the area right of the sidebar. It shows the block card for the
// selected row, and the next row's card already (a look-ahead preview). When
// both cards are from the same file, a dashed connector links them.
//
// A plain, static flex-item class list — no more `${() => ...}` left-offset
// arithmetic here at all. <main> used to be its own independent
// `position:fixed` box, so it had to manually compute a `left-[Nrem]` that
// happened to clear PrInfoPanel's/<aside>'s own widths — three panels kept in
// sync only by hand, with the bottom reservation (below) as the sole
// remaining exception (see AppColumns in home.mjs's mount section for why
// that one still needs to be dynamic). Now that all three are real siblings
// in one flex row (AppColumns), <main> simply takes the remaining space
// (`flex-1 min-w-0`) regardless of which of its neighbours are open/closed —
// removing the entire magic-number system this file used to document here.
//
// `overflow-y-hidden` is explicit, not incidental: per the CSS overflow spec,
// setting one axis to a non-`visible` value (here `overflow-x-auto`, for the
// column-to-column scroll) forces the OTHER axis to compute to `auto` too if
// left at its default `visible` — so without this, <main> itself silently
// became ONE SHARED vertical scrollbar for every column at once (reviewer
// report: columns scrolled together, not independently, and a DOM update
// anywhere in that one shared container could reset the single scrollTop).
// Each column now scrolls internally on its own instead (see block-column's
// and drill-column's own `overflow-y-auto` below), so <main> itself has
// nothing left to scroll vertically.
function DetailPanel(state) {
  return html`
    <main
      class="flex h-full min-h-0 min-w-0 flex-1 flex-row gap-4 overflow-x-auto overflow-y-hidden no-scrollbar transition-all duration-200 ease-out"
      data-testid="detail-panel"
    >
      ${() => {
        // Stop 2b of the left→right nav chain (the methodes-kolom, see
        // TestMethodsColumn.mjs / "Grouping test methods per class" in
        // detail-layout.md): rendered as its OWN sibling column, directly
        // to the LEFT of the block-column below — not nested inside its
        // flex-col (that stacked it ABOVE the diff card instead of beside
        // it, a positioning bug; the doc always described it as a separate
        // column). Explicit deps (not just an incidental codeVersion-bump
        // coupling) so the highlight/border/pill stay correct on their own:
        // classMethodSel (which method is active) and testColumnFocused
        // (the on/off focus border) both need their own rerun trigger here,
        // since TestMethodsColumn/methodRow don't track them internally for
        // every value they use (see TestMethodsColumn.mjs's own comments).
        void state.selected
        void state.focusLevel
        void state.classMethodSel
        void state.testColumnFocused
        void state.mode
        const row = curTestClassRow()
        // Hidden in diff mode: once → steps from the methodes-kolom into the
        // active method's diff, this column slides out of the layout exactly
        // like the pr-index does (testColumnFocused survives the transition,
        // so ← from that diff brings it straight back — see
        // keyboard-navigation.md, stop 2b).
        // Hidden while an "algemene" (PR-wide) comment is being written for
        // the same reason the block column below is (see cs.prWideCompose):
        // that composer is about the PR, not about any code on screen.
        if (!row || state.focusLevel !== 0 || state.mode === 'diff' || isPrWideComposing()) return []
        return [TestMethodsColumn(state, row, toggleTestClassApproval).key('testmethods:' + row.id)]
      }}
      <div
        class="${() =>
          // `hidden` (display:none), not an empty column: an empty flex child
          // would still cost one of <main>'s own gap-4 gaps. Whole-value
          // binding per the arrow.js attribute rule. Its dependencies are
          // cs.prWideCompose and (via commentAnchorColumnHidden/
          // isPrCommentScope) the SELECTION plus state.drill/focusLevel —
          // none of which a change/gran step inside a card touches, so this
          // still adds no per-step attribute mutation (see navigate.spec.mjs's
          // flicker assertion).
          // `overflow-y-auto` (a VISIBLE scrollbar — same reasoning as the
          // Claude chat thread's own, see claude-chat-panel.md) makes this
          // column scroll independently of its neighbours: <main>'s own
          // vertical scroll is now hidden (see DetailPanel's own comment),
          // and this column already stretches to <main>'s full height as a
          // flex-row child, so overflow-y-auto caps it there instead of
          // letting its content (the diff card + its look-ahead preview)
          // grow the whole row tall — same fix as comments-and-related below
          // (the comments/Claude chat/code-preview/Onderliggende-code
          // column), which is where the reviewer-reported tall content
          // actually stacks.
          //
          // isPrCommentScope() (an UNANCHORED comment-index item — a PR-wide
          // comment, an orphan, or an ai_warning with no block) hides this
          // column entirely too, unconditionally (not gated on focusLevel the
          // way commentAnchorColumnHidden is): its own commentDetailCard now
          // renders inside comments-and-related's merged comment-claude-row
          // instead (InlineComments), so there is nothing left to show here —
          // see "The comment-detail card moved into the merged
          // comment-claude-row" in comments-panel.md.
          'flex h-full min-h-0 shrink-0 flex-col gap-3 overflow-y-auto' +
          (isPrWideComposing() || commentAnchorColumnHidden() || unanchoredCommentSelected() ? ' hidden' : '')}"
        data-testid="block-column"
      >
      ${() => {
        // While an "algemene" (PR-wide) comment is being written there is no
        // block/diff to show at all — the composer is about the PR itself.
        // ← closes it and everything comes straight back (exitRelated clears
        // the flag). See "Placing a PR-wide comment yourself" in
        // comments-panel.md. Same for an unanchored comment-index item
        // (isPrCommentScope) — the wrapper above is already `hidden` for it,
        // so there is nothing to build here either.
        if (isPrWideComposing() || unanchoredCommentSelected()) return []
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
          // An anchored comment-index item gets no rail at all — its own
          // drilled column takes this column's place entirely, see
          // commentAnchorColumnHidden (which also hides the wrapper, so this
          // empty array costs no gap).
          if (commentAnchorColumnHidden()) return []
          const selectedBlock = state.blocks[sel] || {}
          return [collapsedColumnHTML(selectedBlock, 0, 'block-collapsed').key('block-collapsed')]
        }
        // The look-ahead preview is the next VISIBLE row, not the raw next
        // index — the same scan ↓ uses (previewIndexAfter/stepVisibleFrom
        // above), so the card stacked under the diff is always exactly the
        // stop ↓ lands on. `null` when the selection is the last visible row:
        // nothing to preview. See "The block column and its neighbour" in
        // .claude/docs/detail-layout.md.
        const previewIdx = previewIndexAfter(sel)
        const pair = state.blocks
          .map((b, i) => ({ b, i }))
          .filter(({ i }) => i === sel || i === previewIdx)
        const out = []
        // Whether the ACTIVE (selected) card is one-sided (added/removed) — see
        // singleSide() in Block.mjs. Task 29: a look-ahead preview next to a
        // one-sided active card must never be WIDER than it. A one-sided active
        // card is already narrow + single-pane on its own, so forcing the
        // preview's viewMode to 'unified' below matches it in width (narrowed())
        // — the same knob the `a` toggle already uses, just conditioned
        // per-render instead of only on the global state.diffViewMode.
        // One-directional only: a two-sided active card never forces a
        // one-sided preview to widen. This no longer guarantees the preview
        // shows nothing the active card doesn't have — a genuinely two-sided
        // preview forced into 'unified' still shows its own old (-) lines,
        // just narrow and stacked instead of side by side. See detail-layout.md.
        // curBlock() (not a raw state.blocks[sel] read) so this resolves
        // through a selected test_class row to its ACTIVE method.
        const activeSingleSided = !!singleSide(curBlock() || {})
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
          // A synthetic comment-index item (kind:'comment', see
          // commentBlockItem/recomputeLeftList) has no diff — never call
          // ensureCode/Block() for it (both assume a real PR block). It gets
          // its own small read-only thread card, to the right of the index,
          // exactly where a Block diff card would otherwise sit — see
          // commentDetailCard (RelatedPanel.mjs) and detail-layout.md
          // ("Comment-index items"). The `.key` includes the comment's own
          // status so a resolve forces a fresh node (same rekey-on-status-
          // change reasoning as the ordinary block-card key below).
          if (b.kind === 'comment') {
            const inner = commentDetailCard(b.comment, {
              preview: i !== sel || !focusedHere,
              // Mouse entry point into prCommentCommandsFor() — the exact
              // same menu Enter already opens on this row (selectedComment()'s
              // branch in onKeydown, checked ahead of the generic block
              // palette — a comment-index item is never stop 1).
              openMenu: (opts) => openMenu('prComment', opts),
            })
            const card = html`<div class="contents" data-testid="detail-card">${inner}</div>`.key(
              'detail:' +
                (i === sel ? 'sel' : 'prev') +
                ':comment:' +
                b.id +
                ':' +
                (b.comment && b.comment.status) +
                // A title arriving later must rebuild this card too — the
                // comment object it captured is replaced wholesale by the
                // comment poll (see titleKeyOf/arrowjs-pitfalls.md).
                ':' +
                (b.comment && commentTitleOf(b.comment) ? 't' : '-'),
            )
            out.push(card)
            return
          }
          // A test_class row (see testClassRowItem/recomputeLeftList) has no
          // diff of its own — its methodes-kolom (stop 2b of the left→right
          // nav chain, see keyboard-navigation.md) renders as its own sibling
          // column, directly to the left of the block-column (see the
          // dedicated slot right above this div). `b` is reassigned here to
          // the ACTIVE method (state.classMethodSel) — every closure below
          // this point that reads `b` therefore already operates on a real
          // PR block, exactly like the ordinary path, with no further
          // special-casing needed.
          const wasTestClass = b.kind === 'test_class'
          if (wasTestClass) {
            // Only the ACTUALLY SELECTED row (i === sel, decision: "zodra een
            // class-rij geselecteerd is") gets the full, interactive
            // methodes-kolom + the active method's diff card. The
            // look-ahead PREVIEW slot (previewIdx, the next VISIBLE row)
            // instead gets a small, dimmed summary card — mirrors how an
            // ordinary preview stays a compact Block() card rather than a
            // fully interactive one.
            if (i !== sel) {
              out.push(testClassPreviewCard(state, b).key('detail:prev:test_class:' + b.id))
              return
            }
            const activeMethod = b.methods[state.classMethodSel] || null
            if (!activeMethod) return
            b = activeMethod
          }
          // A connector/step-down cue only makes sense between two ordinary
          // same-file blocks — never next to a comment item or a test_class
          // row (see testClassRowItem — no connector between/into a class
          // row, decision in detail-layout.md), neither of which has a
          // meaningful shared `.file` at this level.
          if (
            idx > 0 &&
            pair[idx - 1].b.kind !== 'comment' &&
            pair[idx - 1].b.kind !== 'test_class' &&
            !wasTestClass &&
            pair[idx - 1].b.file === b.file
          ) {
            // The step-down cue sits *below* the selected card, just above the
            // dashed connector to the next same-file block ↓ would flow into.
            out.push(stepChevronSlot(1, 'down').key('step-down'))
            out.push(connector().key('conn:' + b.file + ':' + i))
          }
          ensureCode(b)
          const inner = Block(b, {
            // Marks a block whose file is in a landed-but-unpushed commit (see
            // pendingPushFiles/loadPendingPush). Its own nested slot inside
            // Block, so a push landing repaints the chip and nothing else.
            unpushed: () => pendingPushFiles().has(b.file),
            // Marks a block whose file a not-yet-landed Claude edit is
            // currently touching (see checkoutPendingFiles/loadCheckout).
            editing: () => checkoutPendingFiles().has(b.file),
            // Marks a block whose file was just landed but the tree hasn't
            // re-ingested it yet (see checkoutRefreshingFiles/loadCheckout).
            refreshing: () => checkoutRefreshingFiles().has(b.file),
            // Dimmed like the look-ahead preview whenever it isn't the selected
            // card, OR the keyboard focus has stepped off it onto a drilled
            // column (state.focusLevel > 0).
            preview: i !== sel || !focusedHere,
            // Reactive: reads mode/selected/change so the pane re-highlights as
            // the reviewer navigates. Only the selected block, in diff mode,
            // with the keyboard actually on it (not a drilled column), gets a
            // highlighted group.
            // In list mode this previews the first change group (the very run
            // → would step onto). In diff mode it follows state.change into
            // the current granularity's units (a run, a line, or a call
            // segment) — merged with an active Shift+arrow range selection,
            // if any (see rangeUnit/extendRange/isRangeGran). Also feeds the
            // content-driven width, every stand (Block.mjs's contentWidthCls/
            // selectionWindowLineChars): the card sizes off THIS unit's own
            // window (± 2 neighboring changed rows), see topLevelActiveUnit's
            // own doc comment.
            //
            // isActiveCard(), not `i === state.selected`: this closure is a
            // genuine, persistent reactive binding (Block.mjs re-invokes it on
            // every relevant state change, for as long as this card's keyed
            // node stays mounted) — and the card's own `.key(...)` below
            // deliberately does NOT encode `i` (a card that is still, by
            // ROLE, "the selected one" must not be torn down and rebuilt just
            // because its raw array position shifted — see the key's own
            // comment). `i` is therefore a snapshot frozen at whichever
            // render happened to build the mounted node, while `state.selected`
            // is read fresh every time this closure fires. The very
            // recomputeLeftList() calls that follow a `?sel=`/`?tmethod=`
            // restore (loadRelations/loadCallResolve/loadTestCovers/the
            // comment poll landing) can legitimately reindex the still-
            // selected row (recomputeLeftList re-finds it by id, exactly like
            // conventions.md's "snapshot a selection by stable ID, never by
            // raw array index" already requires elsewhere) — once `i` no
            // longer matches the settled `state.selected`, `i === state.selected`
            // is wrong forever and the active-row highlight silently,
            // permanently vanishes with no error (reported bug: the cursor on
            // a restored diff URL flashes once then disappears). Comparing
            // `b`'s own IDENTITY against curBlock() — which itself resolves
            // through state.selected/classMethodSel fresh on every call —
            // gives the same correct answer regardless of which index this
            // closure happened to freeze on. See isActiveCard's own comment.
            activeGroup: () => (isActiveCard(b) && state.focusLevel === 0 ? topLevelActiveUnit(b) : null),
            // Out-of-view change hints belong only to the block being stepped
            // through: the selected card, in diff mode, with the keyboard on it.
            hintsEnabled: () => isActiveCard(b) && state.mode === 'diff' && state.focusLevel === 0,
            // The contextual key-hint line (ShortcutHintBar) — only the card the
            // keyboard is actually on shows one (mirrors hintsEnabled's own gate,
            // minus the diff-mode restriction: blockShortcutHints already covers
            // both list and diff mode itself).
            shortcutHints: () => (isActiveCard(b) && state.focusLevel === 0 ? blockShortcutHints() : []),
            // The description strip's own cursor/disclosure state (see
            // state.descFocusId). Deliberately keyed on b.id — NOT via
            // isActiveCard()/`i` like the bindings around it: these two feed a
            // reactive class attribute on the strip, and depending on
            // state.selected/change would re-set that attribute on every
            // ordinary diff step (tests/navigate.spec.mjs asserts a same-block
            // step only mutates `class` on the <article> cards). A stale id can
            // never light up the wrong card, because there is exactly one
            // descFocusId and it is cleared on every navigation
            // (clearBlockDescFocus).
            descFocused: () => state.descFocusId === b.id,
            descExpanded: () => state.descExpanded.includes(b.id),
            // Mouse twin of Enter on the strip: focus it AND toggle the cap,
            // exactly like clicking a since block/the Omschrijving block at
            // stop 1 (see .claude/docs/mouse-navigation.md). Only wired up for
            // the card the keyboard can actually be on.
            onDescriptionClick:
              i === sel
                ? () => {
                    ensureTopLevelDiffFocus(i)
                    toggleBlockDescExpanded({ focus: true })
                  }
                : undefined,
            // Light-blue border while the keyboard drives this block's diff
            // (selected card, diff mode) — mirrors the selected comment-index row.
            // Drops once the reviewer steps → into the related panel
            // (relatedActive()) or ← into a drilled column (focusLevel > 0).
            diffActive: () => isActiveCard(b) && state.mode === 'diff' && state.focusLevel === 0 && !relatedActive(),
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
            // Mouse entry point into COMMANDS — the exact same expression
            // Enter already runs (see the "Enter" branch in onKeydown), so a
            // click here reaches "Comment op deze regel"/"Chat over deze
            // regel"/"Open GitHub"/approve without the keyboard. `opts` is
            // forwarded straight through to openMenu — a plain click passes
            // nothing (unchanged), a right-click on the card (Block.mjs's own
            // onBlockContextMenu, outside any [data-row]) passes
            // `{native,x,y}` so the SAME call opens the native-styled,
            // cursor-positioned context menu instead.
            onOpenMenu: (opts) => openMenu(state.showDescription ? 'pr' : 'block', opts),
            // The top-level card's own mouse way back out of the diff
            // (leaveDiffToList) no longer has a per-card button — see
            // MainScrollLeftHint, mounted once top-level next to
            // MainScrollRightHint.
            // A mousedown on this card's diff only SEEDS the gesture
            // (beginMouseSelection) — the actual focus/select happens once, on
            // the next mouseup, once we know whether it turned into a plain
            // click or a real (native) selection (resolveClickSelection/
            // resolveRangeSelection, both of which call ensureTopLevelDiffFocus
            // — reviewer request: a click on the non-focused look-ahead
            // preview at i===sel+1 must focus it "alsof je gewoon met je key er
            // navigeert"). Wired unconditionally (not just for the preview) so
            // a click ALSO works on the already-focused card itself — there
            // it's a plain "select this row". `segStart` carries the
            // on-character 'call'-segment precision of a single click — see
            // resolveClickSelection's own comment. `cardEl` scopes a later
            // real selection to this card, `shiftKey` feeds resolveShiftClickSelection.
            onRowMouseDown: (row, segStart, cardEl, shiftKey) =>
              beginMouseSelection(0, b, i, row, segStart, cardEl, shiftKey),
            // Right-click equivalent of onRowMouseDown above — see
            // handleRowContextMenu's own doc comment.
            onRowContextMenu: (row, segStart, x, y) => handleRowContextMenu(0, b, i, row, segStart, x, y),
            // A click on one of Block.mjs's own mouse approve-toggles (the
            // line/group gutter glyphs, a call segment's dot/hover ring) —
            // see approveClickAt's own doc comment.
            onApproveClick: (row, kind, segStart) => approveClickAt(0, b, i, row, kind, segStart),
            // Reactive Set of rows that carry a comment → a 💬 marker on those
            // rows, so it's visible which units already hold a comment (however
            // many). Reads the comments read-model via RelatedPanel.
            commentedRows: () => commentRowSet(b),
            // Reactive Set of the rows spanned by the comment the keyboard is
            // currently IN (empty otherwise) → a vertical bar along the right
            // edge of the diff over exactly those rows, so it's visible which
            // lines/selection the open comment was made on. See
            // commentRangeRowSet (RelatedPanel) and comments-panel.md.
            commentRangeRows: () => commentRangeRowSet(b),
            // Per-line "onderliggende code" rollup (avatar+N comment activity +
            // done/total approve fraction) — see lineChildSummaries' own doc
            // comment. Gran-independent, unlike the panel's own children, so
            // it shows regardless of the current cursor/selection.
            lineSummaries: () => lineChildSummaries(b),
            // For a TRANSLATION block: the other locale files of the same lang
            // file (see ensureLangSiblings below), rendered as extra, read-only
            // columns on every per-key row (translationDiff.mjs's
            // translationBlockView). void state.codeVersion is the same
            // reliable trigger ensureLangSiblings itself bumps on arrival (see
            // its own comment) — a plain state.langSiblings[b.id] read alone
            // has been observed to not always re-notify a dependent closure.
            // Every non-TRANSLATION block simply gets an always-empty array.
            langSiblings: () => {
              void state.codeVersion
              return state.langSiblings[b.id] || []
            },
            // Global diff-pane preference (see state.diffViewMode / the `a` key) —
            // read inside Block's own per-card slot, so toggling re-renders this
            // card's diff structure without touching this outer closure. The
            // preview card (i !== sel) additionally forces 'unified' whenever the
            // active card is one-sided (activeSingleSided, see above) — Task 29,
            // never applied to the selected card itself.
            // Same isActiveCard() reasoning as activeGroup/hintsEnabled/
            // diffActive above — this is the SAME kind of persistent reactive
            // closure (Block.mjs reads it from its own nested slot), so a raw
            // `i !== sel` comparison is exposed to the identical frozen-index
            // hazard.
            viewMode: () => (!isActiveCard(b) && activeSingleSided ? 'unified' : state.diffViewMode),
            // A click on the compact split/unified/fit indicator (only rendered
            // by Block.mjs while diffActive() above is true, i.e. never on
            // the preview card) jumps state.diffViewMode straight to that
            // stand — see applyDiffViewMode/setDiffViewMode.
            setViewMode: setDiffViewMode,
            // Manual column-width override (see columnWidth.mjs /
            // .claude/docs/column-resize.md), keyed by this block's own
            // stable id — independent of role (selected/preview) or drilled
            // depth, so navigating doesn't lose/mix up an override. Only the
            // diffActive() card actually shows the drag handle (gated inside
            // Block.mjs), but the style override itself applies regardless,
            // so a resized-then-stepped-away-from card keeps its width.
            colWidthStyle: () => colWidthStyle(state, 'diff:' + b.id),
            onResizeStart: (e, autoWidthPxFn) => startColumnResize(e, state, 'diff:' + b.id, autoWidthPxFn),
            onResizeReset: () => resetColumnWidth(state, 'diff:' + b.id),
            // Only the look-ahead PREVIEW card (i !== sel) ever collapses to
            // just its header — never the selected/active card itself (undefined
            // there, so Block()'s own "never collapse" default applies). Always
            // true for the preview, unconditionally — see the "look-ahead
            // preview" note above drillPreviewColumns.
            collapsed: i !== sel ? () => true : undefined,
            // Only the look-ahead PREVIEW card ever gets a FIXED width — a
            // flat MIN_CONTENT_WIDTH_CHARS floor, never content-driven,
            // regardless of file type or the preview's own longest line (see
            // Block()'s own `narrowFixed` doc comment). Reviewer decision:
            // since this preview always collapses to just its header anyway
            // (right above), there is no reason for it to ever be wider than
            // the active card next to it — this supersedes the older
            // activeSingleSided/capFitChars mechanism for THIS call site
            // (still content-driven-but-capped for drillPreviewColumns,
            // unchanged, see .claude/docs/diff-card.md).
            narrowFixed: i !== sel ? () => true : undefined,
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
            //
            // Deliberately NOT keyed on `i` (the render's raw state.blocks
            // index): a still-selected row's index can legitimately shift
            // (recomputeLeftList reindexing it by id — see isActiveCard's own
            // comment) without its ROLE changing, and rebuilding the card on
            // every such reindex would tear down/remount it far more than
            // necessary, fighting any in-flight animation/scroll for no
            // reason. That is exactly why activeGroup/hintsEnabled/diffActive/
            // viewMode above compare `b`'s identity via isActiveCard() instead
            // of the frozen `i` — the fix keeps this reuse (patch in place,
            // don't rebuild) correct instead of forcing a rebuild to route
            // around it.
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
          // langSibKeyPart — for a TRANSLATION block, folds the number of
          // fetched sibling locales into the card key too (besides the
          // langSiblings opt Block() itself reads). `inner` is a plain,
          // statically-interpolated value here (${inner}, not a
          // `${() => ...}` binding) — when this whole card's key stays
          // otherwise unchanged, arrow.js reuses the already-mounted node
          // (move+patch) and never re-applies a static interpolation to a
          // reused node (the same "keyed node reuse... does not re-run its
          // [static] bindings" pitfall in conventions.md the rest of this key
          // already guards against for b.code/foc/unfoc). Without this,
          // ensureLangSiblings' fetch landing (state.langSiblings/codeVersion
          // update) genuinely re-runs this whole closure and produces a
          // fresh `inner` with the sibling columns — but the reused card node
          // never shows it. '' for every non-TRANSLATION block (no-op there).
          const langSibKeyPart = b.category === 'TRANSLATION' ? ':lsib=' + (state.langSiblings[b.id] || []).length : ''
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
              b.side +
              langSibKeyPart,
          )
          out.push(card)
          // A changed lang (TRANSLATION) block's sibling locales (the other
          // locale files of the same lang file) render as extra columns
          // INSIDE this same card (see the langSiblings opt above and
          // translationDiff.mjs's translationBlockView) — this only fetches
          // them, only for the selected block (not a preview card), mirroring
          // the old companion-card gating.
          if (i === sel && b.category === 'TRANSLATION') {
            ensureLangSiblings(b)
          }
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
          // Deliberately NOT given its own overflow-y-auto (unlike
          // block-column/comments-and-related below): this div only ever
          // holds the diff card + its own look-ahead preview, and the
          // drill-left-hint chevron right below is absolutely positioned
          // OUTSIDE its own box (-left-3) — giving this div a non-visible
          // overflow-y would (per the CSS overflow spec, which forces the
          // OTHER axis to 'auto' too once one axis isn't 'visible') clip that
          // chevron. The actual tall content (comments/Claude chat/
          // code-preview cards/Underlying code) lives in the separate
          // comments-and-related column below, which gets the scroll fix
          // instead.
          const drillColumnCls =
            'flex min-h-0 shrink-0 flex-col gap-3 scroll-ml-4' +
            (justOpened ? ' drill-enter' : justReturned ? ' drill-return' : '')
          return html`
            <div class="${drillColumnCls}" data-testid="drill-column" data-drill-idx="${i}">
              <div class="relative flex min-h-0 flex-1 flex-col">
                ${
                // The chevron hints at the column this one was drilled FROM —
                // meaningless when that column isn't there: an anchored
                // comment-index item's own top-level column is hidden
                // entirely (commentAnchorColumnHidden), so this drilled
                // anchor IS the leading column.
                focusedHere && !(level === 1 && commentAnchorColumnHidden())
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
                  unpushed: () => pendingPushFiles().has(b.file),
                  editing: () => checkoutPendingFiles().has(b.file),
                  refreshing: () => checkoutRefreshingFiles().has(b.file),
                  // Also feeds the 'fit' stand's width the same way the
                  // top-level card's activeGroup does — see
                  // focusedActiveUnit's own doc comment.
                  activeGroup: () =>
                    state.focusLevel === level && !commentAnchorAwaitingEntry(level) ? focusedActiveUnit() : null,
                  hintsEnabled: () => state.focusLevel === level,
                  diffActive: () =>
                    state.focusLevel === level && !relatedActive() && !commentAnchorAwaitingEntry(level),
                  // Same gate as hintsEnabled above, minus the diff-mode
                  // restriction (blockShortcutHints covers both modes itself).
                  shortcutHints: () => (state.focusLevel === level ? blockShortcutHints() : []),
                  approvedRows: () => approvedRowSet(b),
                  approvedCalls: () => approvedCallSet(b),
                  onApprove: (blk) => persistApproval(blk),
                  // Mouse entry point into COMMANDS — mirrors the top-level
                  // card's own wiring above (state.showDescription is never
                  // true for a drilled column, but the same expression keeps
                  // both call sites identical).
                  onOpenMenu: (opts) => openMenu(state.showDescription ? 'pr' : 'block', opts),
                  // Mouse entry point back to the parent column — the exact
                  // same call the ← key already runs at focusLevel>0 (see
                  // closeDrilledColumn, above expandColumn). This column is
                  // always the focused one when rendered as a full card (a
                  // non-focused one collapses to the rail instead), so no
                  // level check is needed here.
                  onCloseColumn: () => closeDrilledColumn(),
                  // This card is always the focused drilled column (a
                  // non-focused one collapses to the rail above, whose own
                  // click already calls expandColumn) — so a click here only
                  // needs to hand focus back from the comments/Onderliggende-
                  // code panel when needed, never a level change. `segStart`
                  // is dropped (never passed through) — a drilled column's
                  // click stays 'line'-only, no call-segment precision there,
                  // same as before; a real (native) selection/Shift+click
                  // still ranges here via the same mouseup resolution.
                  onRowMouseDown: (row, segStart, cardEl, shiftKey) =>
                    beginMouseSelection(level, b, null, row, null, cardEl, shiftKey),
                  // Right-click equivalent — mirrors onRowMouseDown's own
                  // 'line'-only restriction (segStart dropped) and
                  // the top-level card's onRowContextMenu wiring above.
                  onRowContextMenu: (row, segStart, x, y) => handleRowContextMenu(level, b, null, row, null, x, y),
                  // Mirrors the top-level card's own wiring above — see
                  // approveClickAt's own doc comment.
                  onApproveClick: (row, kind, segStart) => approveClickAt(level, b, null, row, kind, segStart),
                  commentedRows: () => commentRowSet(b),
                  commentRangeRows: () => commentRangeRowSet(b),
                  lineSummaries: () => lineChildSummaries(b),
                  // Follows the shared stand like every other column — the
                  // anchored comment-index item's own column used to default
                  // to Unified via a separate state.commentAnchorViewMode
                  // field; removed on reviewer request ("hetzelfde zien als
                  // via de code genavigeerd"), see openCommentAnchorDrill.
                  viewMode: () => state.diffViewMode,
                  setViewMode: (m) => setDiffViewMode(m),
                  // Same manual column-width override as the top-level card
                  // (see columnWidth.mjs) — a drilled column gets its own
                  // independent override, keyed by its own block's id (a real
                  // block or a synthetic call-frame, both already carry a
                  // stable b.id, see drilling.md).
                  colWidthStyle: () => colWidthStyle(state, 'diff:' + b.id),
                  onResizeStart: (e, autoWidthPxFn) => startColumnResize(e, state, 'diff:' + b.id, autoWidthPxFn),
                  onResizeReset: () => resetColumnWidth(state, 'diff:' + b.id),
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
      ${
        // ml-2 on top of <main>'s own gap-4: a little extra breathing room
        // specifically between the diff card (or the last open drill
        // column) and this comments/Onderliggende-code column, requested
        // so the purple call-arrow overlay isn't pinched against the
        // comment card's border. Static class, not reactive — no arrow.js
        // whole-value-attribute concern.
        //
        // The div right below also carries `h-full overflow-y-auto` (a
        // VISIBLE scrollbar, same reasoning as the Claude chat thread's own
        // — see claude-chat-panel.md): this ONE column (rendered once, for
        // whichever block/drilled unit is focused — comment-claude-row + the
        // code-preview column + the Onderliggende-code panel, in DOM order)
        // is exactly where the reviewer-reported "code blocks fall out of
        // view behind the footer" content stacks tall. Independent scroll
        // here, same as block-column above, so it no longer shares <main>'s
        // own (now-hidden) vertical scroll with the diff column next to it.
        ''
      }
      <div
        class="flex h-full min-h-0 shrink-0 flex-col gap-3 overflow-y-auto ml-2"
        data-testid="comments-and-related"
      >
        <div
          class="${() =>
            // Hidden (not unmounted!) while neither InlineComments/
            // ClaudeChatPanel/the composer has anything to show
            // (claudeChatVisible()) NOR the shared footer does
            // (hasCommentClaudeFooter()) — without this the bordered card
            // still rendered with zero-height content on a line with no
            // comments/Claude chat and nothing in flight, showing as a bare
            // thin gray bar above Onderliggende code (see
            // .claude/docs/comments-panel.md). Deliberately a CSS `hidden`
            // toggle, not a conditionally-mounted subtree: InlineComments()
            // itself starts the comment poll (syncComments) as a plain call
            // in its own body, not behind a watch — unmounting it here would
            // stop that poll from ever running until the row is already
            // visible, a chicken-and-egg deadlock that never flips
            // claudeChatVisible() to true in the first place.
            //
            // Deliberately NO `overflow-hidden` here (removed — a fresh,
            // empty composer/Claude column used to render as a bare
            // composeTargetHint bar with nothing below it, see the
            // "overflow-hidden + justify-end" note in detail-layout.md):
            // with an `overflow-hidden` ancestor, Chromium computes the
            // auto-height of EVERY intermediate flex-col ancestor up to and
            // including that ancestor as 0 the moment a nested flex item
            // (inline-comments, `justify-end`, added for the bottom-align
            // fix) sits in an indefinite-height flex context — not just its
            // immediate parent. The composer/Claude content itself still
            // rendered with the right text, just clipped away above a
            // collapsed 0px row. Every nested card already carries its own
            // border/rounding/padding that never touches this row's own
            // edge, so dropping `overflow-hidden` here costs nothing
            // visually.
            //
            // `!hasAnyComments()` (not folded away by hiddenAboveCount) is a
            // fourth condition: a unit whose only comment is a stale
            // (unpinned) one still has the "N hierboven" hint to show —
            // hiding this whole row would make that hint's own promised
            // navigation route unreachable. See "A stale (unpinned) comment
            // is always folded..." in comments-panel.md.
            (!claudeChatVisible() && !hasCommentClaudeFooter() && !hasAnyComments()
              ? 'hidden'
              : 'flex flex-col rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5')}"
          data-testid="comment-claude-row"
        >
          ${() =>
            // The "linked to" code-preview hint (composeTargetHint) — either
            // the open new-comment composer's own target, or the currently
            // expanded existing conversation's own anchor (see
            // activeComposeTargetHint's own doc comment). Spans the FULL
            // width of the merged card (over both the comment and the Claude
            // column below), not just the comment column's own half — the
            // anchor is shared by both, so the preview isn't a comment-only
            // thing. The whole wrapper (padding included) is gated on the
            // SAME condition as the template it holds, so no bare empty
            // padded strip shows when there's nothing to preview.
            activeComposeTargetHint(commentTarget)
              ? html`<div class="px-3 pt-3">${composeTargetHint(activeComposeTargetHint(commentTarget))}</div>`
              : ''}
          <div class="flex items-stretch overflow-hidden" data-testid="comment-claude-columns">
            ${() =>
              InlineComments(
                state,
                commentTarget,
                // Mirrors the Enter branch in onKeydown above (a click runs the
                // same function a key runs): only a conversion of an AI-controle
                // finding still goes through the comment-kind menu, an ordinary
                // composer posts straight away via runComposePost.
                () => {
                  if (composeHasText()) {
                    if (isConvertingAiWarning()) openMenu('compose')
                    else runComposePost()
                  }
                },
                // Mouse-only equivalent of Enter on a focused, empty-reply comment
                // (isCommentOrThreadFocused() && commentReplyEmpty(), see onKeydown below) —
                // a click on the reply-status button next to "Stuur" opens the same
                // comment-scoped menu (Resolve/Delete/Open op GitHub) without
                // requiring the reply field to be empty first, since a direct click
                // is an unambiguous request, unlike the overloaded Enter key. `opts`
                // forwards straight to openMenu (a right-click passes
                // {native,x,y} — see "The right-click context menu" in
                // command-palette.md), same shape as every other onOpenMenu.
                (opts) => openMenu('comment', opts),
                // The merged detail-card slot's own menu (isPrCommentScope,
                // see InlineComments' own doc comment) — the exact same menu
                // Enter already opens on this row (selectedComment()'s branch
                // in onKeydown), a comment-index item is never stop 1.
                (opts) => openMenu('prComment', opts),
              ).key('inline-comments')}
            ${() =>
              // A vertical dashed separator (not the horizontal connector
              // nestedChipColumn uses between Onderliggende-code children) —
              // the comment and Claude blocks merge into ONE visual card (the
              // border/bg above), so this is an internal divider, not a
              // connector between two separate cards. Visible only alongside
              // the Claude column itself (claudeColumnVisible() — the narrower
              // predicate, so no dash while an "algemene" comment is being
              // written and there is no Claude half at all), so there's never
              // a floating dash with nothing to its right. `self-stretch`
              // spans the row's full (items-stretch-driven, equal) height.
              claudeColumnVisible()
                ? html`<div
                    class="w-3 shrink-0 self-stretch border-l border-dashed border-slate-300 dark:border-zinc-700"
                    data-testid="comment-claude-connector"
                  ></div>`
                : ''}
            ${() => ClaudeChatPanel(state, commentTarget).key('claude-chat')}
          </div>
          ${() =>
            // One shared status footer for BOTH columns (comment send/busy
            // status + Claude's own live-turn status) — replaces the former
            // per-column status spots, see CommentClaudeFooter's own doc
            // comment. Renders nothing at all when neither side has anything
            // to report.
            CommentClaudeFooter()}
          ${ShortcutHintBar(commentClaudeShortcutHints)}
        </div>
        ${() =>
          // The standalone code-preview column — always on, one stacked
          // column showing every code fence currently visible in the
          // comment/Claude columns (markdown.mjs, suggestion fences
          // included). A sibling ROW below comment-claude-row (not to its
          // right any more, see "Always on, stacked BELOW (reversing D3
          // again)" in claude-chat-panel.md), bounded to that row's own real
          // width (commentClaudeRowWidthCls, RelatedPanel.mjs) so it can
          // never spill wider than comment-claude-row above it.
          // It renders nothing while the general-chat overlay is up (that
          // overlay mounts its own copy, next to the same conversation's chat
          // card) — gated inside CodePreviewPanel itself, see its `inOverlay`
          // option and setGeneralChatOverlayVisible (RelatedPanel.mjs).
          CodePreviewPanel(state, commentTarget)}
        ${() =>
          RelatedPanel(state, commentTarget, { drill: handleRelatedDrill }).key('related-panel')}
      </div>
      <div class="-ml-4 h-1 w-px shrink-0" data-testid="main-overflow-sentinel"></div>
    </main>
  `
}

// mainScrollRightHint — the mouse-only way to reach content overflowing off
// the right of <main>'s own column flow (list mode and diff mode alike):
// reviewer request, mirroring Block.mjs's diffLeaveRail in visual language
// (small bordered rail, own icon) but fixed to the top-right corner of the
// viewport rather than scrolling along with the content — it must stay
// reachable regardless of the current scroll position, which is exactly
// the opposite of diffLeaveRail's own placement (flush against the card it
// belongs to). Click hides exactly one column at a time
// (scrollMainRightOneColumn) — no "jump all the way" shortcut, per the
// reviewer's explicit "stap voor stap" request. Mounted once, top-level,
// like Footer/ProgressBar/MenuHost; visibility is a nested `${() => ...}`
// slot inside a stable element root (never a bare toggling expression, see
// arrowjs-pitfalls.md) driven by state.mainOverflowRight.
//
// Opacity is reactive on its own (`${() => ...}` on the whole class value,
// per the arrow.js whole-attribute-value rule) rather than static
// `hover:`/`focus-within:` alone: reviewer request, `state.mouseActiveHints`
// (any mouse movement anywhere on the page, see its own doc comment above)
// ORs into the same `hover:`/`focus-within:` classes so the button also
// reveals without the cursor having to land exactly on its small
// fixed-corner box. `hover:opacity-100` stays alongside it (not replaced) so
// resting the cursor on the button to click it doesn't have the button fade
// out from under the pointer after 5s of no further movement.
function MainScrollRightHint(state) {
  return html`
    <div class="contents">
      ${() =>
        state.mainOverflowRight
          ? html`
              <div
                class="${() =>
                  'fixed top-6 right-0 z-30 flex shrink-0 flex-col gap-1 rounded-l-lg border border-r-0 border-slate-300 bg-white p-1 shadow-md transition-opacity hover:opacity-100 focus-within:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 ' +
                  (state.mouseActiveHints ? 'opacity-100' : 'opacity-0')}"
                data-testid="main-scroll-right-hint"
              >
                <button
                  type="button"
                  title="${t('Meer naar rechts')}"
                  data-testid="main-scroll-right-button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
                  @click="${(e) => {
                    e.stopPropagation()
                    scrollMainRightOneColumn()
                  }}"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
                    <path d="M6 3l5 5-5 5" stroke-linecap="round" stroke-linejoin="round"></path>
                  </svg>
                </button>
              </div>
            `
          : ''}
    </div>
  `
}

// MainScrollLeftHint — the exact mirror of MainScrollRightHint above, for the
// left-hand chain: leave the diff -> the block list -> the PR description
// (stop 3 -> stop 2 -> stop 1), replacing the old two-icon diffLeaveRail /
// block-open-description rail that used to live glued to the top-level card
// in Block.mjs (reviewer request: one persistent button, always in the same
// fixed spot, one column opened per click — the exact "stap voor stap"
// contract MainScrollRightHint already has, rather than a state-based rail
// tied to one card). Each click runs stepMainLeftOneColumn(), which is
// exactly what a single ← already does at that stop — the click-runs-the-
// same-function rule in mouse-navigation.md. Only visible while
// canStepMainLeft() is true, i.e. there's something left to reveal; hidden
// for a drilled column (its own "Sluit deze kolom" button in Block.mjs
// covers that) and once the description is already open.
//
// Position: `left-0` matches MainScrollRightHint's own corner (`right-0`)
// exactly, in BOTH modes — reviewer request: the back button must sit flush
// against the true viewport edge, not tucked in next to the pr-index. In
// diff mode <main> effectively starts at the viewport's own left-6 (the
// pr-index (<aside>) is collapsed to width 0 then, see detail-layout.md) so
// there's nothing to overlap. In list mode the pr-index occupies that
// top-left corner too (`w-[26rem]`, visually pinned there via AppColumns'
// own fixed `left-6`, see BlockList.mjs) whenever this button would show
// (canStepMainLeft() is only true there while the description ISN'T open
// yet, i.e. the pr-index is fully visible) — the button now sits in the
// blank `left-6` gutter to its left, matching the diff-mode gutter case
// below, rather than past its right edge.
// canStepMainLeftPositionCls() is its own small reactive slot so only the
// position (not the whole button) reruns on a mode change.
// In diff mode it stretches from top-6 to bottom-6 — the hover-catching zone
// spans the whole (blank) left gutter, see canStepMainLeftZoneCls below for
// why. The visible icon itself still sits at the very top (`items-start`).
function canStepMainLeftPositionCls() {
  return state.mode === 'diff' ? 'top-6 bottom-6 left-0' : 'top-6 left-0'
}
// canStepMainLeftZoneCls() — the width of the invisible HOVER-CATCHING zone,
// separate from the visible icon box nested inside it (`group`/
// `group-hover:`, same reasoning as `block-open-menu`'s reveal — see
// mouse-navigation.md). In diff mode there is a real, empty gap between the
// true viewport edge (where the icon itself sits, per the "tegen de rand"
// request) and the diff card's own visible left edge: AppColumns' own
// `left-6` inset PLUS one `gap-6` that still applies before <main> even
// though the collapsed <aside> takes zero width (a flex `gap` reserves its
// space between EVERY pair of children, collapsed-width or not) — about 48px
// of blank page background. Regression found after the AppColumns merge
// (0fe3d4b): the icon's own hover target used to double as "hover the visible
// card's corner", because before that merge the card sat flush against this
// same x:0 spot; once the card moved ~48px right, that blank gap became a
// dead zone nobody would think to point at, and the hint was reported as
// "never shows even when I move the mouse around". Widening the invisible
// catcher (not the visible icon) to span that whole gutter means a mouse
// travelling from the edge toward the card passes over it either way. List
// mode now has the same kind of gap since the button moved flush to
// `left-0` (the pr-index itself starts at `left-6`), just narrower (~24px,
// no extra `gap-6` in front of it since <aside> is the first flex child) —
// it keeps a tight zone matching the icon's own size regardless, since that
// narrower gutter is still comfortably wider than the icon box itself.
//
// In diff mode that zone also spans the FULL height of the viewport
// (`top-6 bottom-6` via the position class, `h-9` dropped), on reviewer
// request: "als het PR-omschrijvingsblok niet meer zichtbaar is, laat die knop
// dan zien als ik met mijn muis beweeg — hij bestaat al, maar is niet
// zichtbaar". A 36px-tall catcher in the top-left corner is simply not
// something a mouse passes over by accident, so the button that walks back to
// that hidden column was effectively undiscoverable. The whole left gutter is
// blank page background in diff mode (see above), so widening the catcher
// downward swallows no click: the diff card's own left edge starts to the
// right of it. `group`/`group-hover` still stays as one of two ways to reveal
// it (see MainScrollRightHint's own doc comment above for the other,
// `state.mouseActiveHints`), so this remains an accepted exception to Rule 4
// in mouse-navigation.md, not a state read that gates any keyboard-only
// functionality.
//
// List mode keeps the small `h-9` box: there the hint now sits at `left-0`,
// just left of the pr-index's own `left-6` edge, and a full-height strip
// there WOULD swallow clicks/drag-selections along that card's left edge.
function canStepMainLeftZoneCls() {
  return state.mode === 'diff' ? 'w-12' : 'h-9 w-9'
}
function MainScrollLeftHint(state) {
  return html`
    <div class="contents">
      ${() =>
        canStepMainLeft()
          ? html`
              <div
                class="${() =>
                  // No `h-9` here: the height comes from the position class
                  // (diff mode stretches top-6..bottom-6) or from the zone
                  // class (list mode keeps its own h-9 box).
                  'group fixed z-30 flex items-start justify-start ' +
                  canStepMainLeftPositionCls() +
                  ' ' +
                  canStepMainLeftZoneCls()}"
                data-testid="main-scroll-left-hint"
              >
                <div
                  class="${() =>
                    'flex shrink-0 flex-col gap-1 rounded-lg border border-slate-300 bg-white p-1 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 ' +
                    (state.mouseActiveHints ? 'opacity-100' : 'opacity-0')}"
                >
                  <button
                    type="button"
                    title="${t('Terug (één stap)')}"
                    data-testid="main-scroll-left-button"
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
                    @click="${(e) => {
                      e.stopPropagation()
                      stepMainLeftOneColumn()
                    }}"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4 -scale-x-100" aria-hidden="true">
                      <path d="M6 3l5 5-5 5" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </button>
                </div>
              </div>
            `
          : ''}
    </div>
  `
}

// AppColumns — the one fixed row that replaces the old three independently
// `position:fixed` panels (PrInfoPanel/<aside>/<main>). Real flex siblings
// now, in DOM order left→right, so a closed/collapsed column (PrInfoPanel
// unmounted, <aside> collapsed to width 0, see their own class comments)
// genuinely gives its space back to its neighbours instead of merely being
// covered by a translate/opacity trick while <main> separately (and
// fragilely) computed a matching offset by hand — that hand-synced-offset
// system is gone; <main> is just `flex-1 min-w-0` now (see DetailPanel's own
// doc comment) and reflows automatically whichever of its neighbours are
// open. See "Columns instead of independently fixed panels" in
// detail-layout.md.
//
// The wrapper itself keeps the one offset that still has to react to state:
// the bottom footer reservation. PrInfoPanel/<aside> never need it — the
// footer only ever shows content in diff mode, exactly when <aside> is
// collapsed (see BlockList.mjs) — so applying it to the whole row is
// equivalent to the old <main>-only reservation, without a separate
// per-child value.
function AppColumns(state) {
  return html`
    <div
      class="${() =>
        'fixed left-6 right-0 top-6 z-10 flex min-h-0 items-stretch gap-6 transition-all duration-200 ease-out ' +
        (!state.footerVisible ? 'bottom-6' : `bottom-[${footerBoxPx(state) + PROGRESS_BAR_PX}px]`)}"
      data-testid="app-columns"
    >
      ${PrInfoPanel(state)} ${BlockList(state, isPrWideComposing, revealApprovedBlocks)} ${DetailPanel(state)}
    </div>
  `
}

// Mount the app's column row into #app. Comments and Tasks are no longer
// separate mounts — comments render inline inside DetailPanel's <main>, Tasks
// inside PrInfoPanel's own column.
const app = document.getElementById('app')
AppColumns(state)(app)
setupMainOverflowObserver()
MainScrollRightHint(state)(app)
MainScrollLeftHint(state)(app)
MenuHost()(app)
ImageLightboxHost()(app)
// The werkmap overlay (workDirOverlay.mjs) — top-level like MenuHost, and
// initialized with the state + the one write path it may use
// (sendCheckoutAction, which only ever starts/signals the chat_merge queue).
initWorkDirOverlay(state, sendCheckoutAction)
WorkDirOverlayHost()(app)
// The general-chat overlay (generalChatOverlay.mjs) — same top-level mount,
// same "owns the keyboard while open" contract; see onKeydown.
initGeneralChatOverlay(state)
GeneralChatOverlayHost()(app)
// The call-arrow overlay: one static fixed <svg> drawn imperatively (see
// src/callArrows.mjs). Top-level like MenuHost — inside <main> its z-index
// would be capped at <main>'s own z-10 stacking context.
CallArrowsHost()(app)
Footer(state)(app)
ProgressBar(state)(app)
TopLoadingBar(state, topLoadingActive)(app)

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
// Plain focus, deliberately NOT activateSearch(): this is a load-time
// convenience (let the reviewer start typing a filter right away, no click
// needed), not an arrival at the sidebar's ↑/↓ loop stop — see
// focusSearchBox/activateSearch above. Using activateSearch here would mark
// state.searchLoopFocused true from the very first paint, so a completely
// ordinary first ArrowDown/ArrowUp would misfire straight into the loop-exit
// behaviour instead of simply walking the list.
// ALSO gated on hadInitialSelParam: a genuinely fresh open (no `?sel=` at
// all) lands on stop 1 instead (see loadBlocks' own `!hadSelParam ->
// showDescription = true`), so the reviewer is looking at the PR summary,
// not the block index — grabbing real keyboard focus into the search box
// here would contradict that (see "act as if the PR-summary block is
// selected" in keyboard-navigation.md). A restored `?sel=` keeps the
// existing convenience unchanged.
// ALSO skipped for a `?tcol=1` restore (testColumnPending, see the
// bindUrlState entry above): that URL says the reviewer had the methodes-kolom
// focused, and onKeydown's searchActive branch owns ↑/↓ while the box holds the
// keyboard (searchStepSelection walks the INDEX) — so grabbing focus here would
// silently undo the very thing tcol restores. Read via the pending snapshot,
// not state.testColumnFocused: the flag itself is only applied later, by
// applyTestClassRefRestore after loadBlocks lands, while this rAF is scheduled
// now.
if (state.mode === 'list' && hadInitialSelParam && !testColumnPending)
  requestAnimationFrame(focusSearchBox)

// Kick off the initial load.
loadBlocks()
loadPRMeta()
loadPendingPush()
loadCheckout()
ensurePraiseWords()
pollWorkflows()
setInterval(pollWorkflows, WORKFLOWS_POLL_MS)
pollProblems()
setInterval(pollProblems, PROBLEMS_POLL_MS)
// The git+DB-backed "has the tree caught up with a landed chat edit" backstop
// (loadPendingPush) runs on its own slow timer too, so a missed
// blocks.changed/pendingpush.changed frame can only delay a landing becoming
// visible by one tick instead of until a manual reload — see loadPendingPush.
setInterval(loadPendingPush, PENDING_PUSH_POLL_MS)

// callresolve/testcovers' LLM search keeps running server-side well after
// loadBlocks' own one-shot fetch above (resolve_call/resolve_test_covers are
// started fire-and-forget right after ingest/a rebuild, see
// autoStartResolveCall in .claude/docs/workflows-analysis.md) — without this,
// a reviewer who stays on the page never sees a child resolve, while a fresh
// tab opened a bit later fetches the by-then-already-resolved read model and
// sees more (the "navigation looks frozen right after Generate" symptom).
// Mirrors RelatedPanel.mjs's ensureChatEvents: an event only says "something
// changed", loadCallResolve/loadTestCovers stay the actual read (both already
// call recomputeLeftList themselves, so no extra plumbing is needed here).
// This module runs once per page load (no SPA routing), so — unlike
// ensureChatEvents, which can be called again per opened comment thread — no
// "already bound" dedupe guard is needed.
ensureEvents(state.pr)
onEvent('callresolve.changed', () => loadCallResolve())
onEvent('testcovers.changed', () => loadTestCovers())
// A landing or a push changes what still has to be pushed — the todo row at the
// bottom of the index and the per-block "ongepusht" marking both read that one
// read model, so one refetch covers both.
onEvent('pendingpush.changed', () => loadPendingPush())
// The checkout chip's own state (a directory got assigned/freed, a decision
// needs answering, a stash got restored) — fired both by the checkout-menu
// Actions and by an ordinary chat turn resolving it on its own.
onEvent('checkout.changed', () => loadCheckout())
// The pr_status tracker re-derived the PR-info column's data (typically the
// "Sinds jouw laatste review" block, whose Haiku explanation lands seconds
// after pollPRMeta already stopped) — one refetch, per the event-bus contract
// that an event is never the truth. See .claude/docs/server-events.md.
onEvent('prmeta.changed', () => {
  fetchPRMetaOnce().catch(() => {
    /* transient — the next event or a reload picks it up */
  })
})
// New commits were ingested while this tab was open (a colleague pushed, or a
// chat edit landed). loadBlocks() runs exactly once, at page load, so without
// this the tree silently stays a version behind — the PR 13255 symptom, where
// the server had re-ingested a colleague's commit within a minute and nothing
// on screen said so.
//
// Deliberately a flag, NOT a refetch: reloading the tree under an active cursor
// would move the selection and reset a half-finished approve pass. The notice
// row this drives (staleTreeRow, BlockList.mjs) lets the reviewer pick the
// moment, and reloads the page so ?sel=/?drill= restore the position against a
// guaranteed-consistent tree.
//
// NOT in onEventsResync: a resync means "you may have missed a frame", which is
// not evidence that anything actually changed — flagging the tree stale there
// would put the notice on screen after any ordinary reconnect (a laptop waking
// up, a server restart). A genuinely missed blocks.changed costs at most one
// stale tree until the next refresh, which is the same risk the reviewer
// already had before this existed.
onEvent('blocks.changed', (ev) => {
  // ev.data.landedFiles: which files (if any) a REVIEWER'S OWN just-landed
  // chat edit touched — set by refreshIngestDelta (workflows.go) directly in
  // this event's own payload, computed atomically in the SAME Activity call
  // that swapped the blocks table (see blocksChangedPayload, eventbus.go, and
  // "Wordt bijgewerkt" in .claude/docs/pending-push.md). Reading it straight
  // off the event is deliberate: state.checkout.refreshingFiles (a SEPARATELY
  // fetched read model) cannot be trusted for this decision — tembed drives a
  // landing's whole ingest-refresh fully inline/synchronously, so blocks.changed
  // can reach this tab before any fetch of that other read model would ever
  // see it non-empty. Still only a ROUTING hint, never the truth: either
  // branch below still does a real read (refreshBlocksAfterOwnLanding fetches
  // GET /api/blocks for real; the manual path re-reads on the reviewer's own
  // reload) — a missing/dropped frame simply falls back to the existing
  // manual staleTreeRow path, exactly as before this feature existed.
  const files = ev && ev.data && Array.isArray(ev.data.landedFiles) ? ev.data.landedFiles : []
  if (files.length) {
    refreshBlocksAfterOwnLanding(files)
    // Best-effort refresh of the (purely cosmetic) "wordt bijgewerkt" pill —
    // unrelated to the decision above, which never depends on this read model.
    loadCheckout()
  } else {
    state.blocksStale = true
  }
})
onEventsResync(() => {
  loadCallResolve()
  loadTestCovers()
  loadPendingPush()
  loadCheckout()
})
