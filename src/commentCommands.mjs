// commentCommands.mjs — the command-palette lists for comments and the Claude
// chat: the block-scoped comment menu, the Claude-column menu, the PR-wide
// comment menu, the comment-kind (compose) menu and the reply-publish menu.
// Shared by the review tree (home.mjs) and the QA page (qa.mjs), so both offer
// exactly the same menus on the same RelatedPanel.mjs comment/Claude block.
//
// Every list is built fresh at open time. Whatever depends on the HOST page —
// where the keyboard lands after a resolve/delete/publish, the PR URL, the
// tree-only Ignore toggle — comes in through the `host` object:
//   afterResolve(fn)         run fn (the resolve), then the page's follow-up
//   deleteFocused()          delete the focused block-scoped comment
//   deletePrComment(c)       delete a PR-wide comment item
//   publishThread(c, withHistory, how?)  "Zet op GitHub" on a block-scoped thread
//   publishPrComment(c, withHistory)     the same for a PR-wide item
//   selectedComment()        the selected PR-wide comment item (or null)
//   clearClaudeChat()        "Wis Claude-gesprek"
//   prUrl()                  the PR's GitHub URL
//   composePost(opts)        place the composer's comment
//   granNoun()               the composer target's unit noun
//   ignore?                  { isIgnored(), toggle(c) } — tree only
// See "The shared comment/Claude menus" in .claude/docs/command-palette.md.
import { t } from './i18n.mjs'
import { meLogin } from './avatar.mjs'
import {
  focusedComment,
  focusedCommentGithubId,
  focusedThreadMessage,
  focusedPrThreadMessage,
  isOwnMessage,
  startEditMessage,
  convertWarningToComment,
  convertPrWideWarningToComment,
  needsPublishChoice,
  localReplyCount,
  publishThreadOnly,
  publishThreadAsPrWide,
  threadPublishNeedsReviewerChoice,
  isChatAnchorPlaceholder,
  firstReviewerReplyOnPlaceholder,
  resolveFocusedComment,
  unresolveFocusedComment,
  claudeChatShadowWarning,
  activeClaudeMessage,
  canEditClaudeMessage,
  startEditClaudeMessage,
  claudeAnchorIsPlaceholder,
  convertClaudeAnchorToComment,
  retryClaudeTurn,
  cancelClaudeTurn,
  startPrCommentReply,
  startPrCommentChat,
  resolvePrCommentItem,
  unresolvePrCommentItem,
  pendingPublishInfo,
  sendPendingReply,
  pendingPublishNeedsReviewerChoice,
  sendPendingAsPrWide,
} from './RelatedPanel.mjs'

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
export function withClose(list, onClose) {
  return [{ id: 'close-menu', label: t('Sluit menu'), hint: 'sluit', run: onClose || (() => {}) }, ...list]
}

// isResolvedComment — whether a comment thread is currently resolved, i.e.
// whether its menu offers "Unresolve comment" instead of "Resolve comment".
// Both menus below show exactly ONE of the two, in the same slot, so the
// default-Enter item keeps meaning "flip this thread's state".
export function isResolvedComment(c) {
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
export function isAiComment(c) {
  return !!c && ((c.source || '') === 'ai' || c.kind === 'ai_warning')
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
export function isOwnComment(c) {
  if (!c) return false
  if (!c.source || c.source === 'ui') return true
  return c.source === 'github' && !!meLogin() && c.author === meLogin()
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
export function publishThreadCommand(c, doPublish, doPrWide) {
  const n = localReplyCount(c)
  const isAI = (c.source || 'ui') === 'ai'
  const rootNoun = isAI ? t('de AI-melding') : t('mijn comment')
  const publish = doPublish || ((withHistory) => publishThreadOnly(c, withHistory))
  const prWide = doPrWide || ((withHistory) => publishThreadAsPrWide(c, withHistory))
  // On a PR the reviewer doesn't review, an inline publish makes them a
  // reviewer for good (see NOT_REVIEWER_COMMANDS): say so, and offer the
  // PR-wide way too. Inline stays first, i.e. the default.
  const notReviewer = threadPublishNeedsReviewerChoice(c)
  const asReviewer = (label) => (notReviewer ? t('{label} (je wordt reviewer)', { label }) : label)
  const prWideItems = (withHistory, id, label) =>
    notReviewer ? [{ id, label, hint: 'hele PR', run: () => prWide(withHistory) }] : []
  if (n === 0 && !notReviewer) {
    return {
      id: 'comment-publish',
      label: t('Zet op GitHub'),
      hint: 'github',
      run: () => publish(false),
    }
  }
  const items = [
    {
      id: 'comment-publish-root',
      label: asReviewer(t('Alleen {noun}', { noun: rootNoun })),
      hint: 'alleen dit',
      run: () => publish(false),
    },
  ]
  if (n > 0) {
    items.push({
      id: 'comment-publish-history',
      label: asReviewer(t(n === 1 ? 'Met de eerdere {n} bericht' : 'Met de eerdere {n} berichten', { n })),
      hint: 'hele gesprek',
      run: () => publish(true),
    })
  }
  items.push(
    ...prWideItems(
      false,
      'comment-publish-prwide',
      t('Alleen {noun} als algemene comment (geen reviewer)', { noun: rootNoun }),
    ),
  )
  if (n > 0) {
    items.push(
      ...prWideItems(
        true,
        'comment-publish-prwide-history',
        t('Het hele gesprek als algemene comment (geen reviewer)'),
      ),
    )
  }
  return {
    id: 'comment-publish',
    label: t('Zet op GitHub'),
    hint: 'github',
    children: withClose(items),
  }
}

export function commentCommandsFor(host) {
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
            run: () => host.afterResolve(() => resolveFocusedComment()),
          },
    )
  }
  // "Verwijder comment" is only offered for a comment that is OURS to remove:
  // one placed in this app, an AI finding, or an imported comment the local
  // reviewer wrote themselves (isOwnComment covers that last case). Someone
  // else's remark imported from GitHub is never deletable from here —
  // reviewer instruction, "ik wil geen comments van anderen kunnen
  // verwijderen". The backend enforces the same rule independently (see
  // deleteGithubComment's ownership guard in workflows.go), so hiding the
  // item is the UI half of it, never the only line of defence.
  if (isOwnComment(focused) || isAiComment(focused)) {
    items.push({
      id: 'delete-comment',
      label: t('Verwijder comment'),
      hint: 'delete',
      run: () => host.deleteFocused(),
    })
  }
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
    items.push(
      publishThreadCommand(
        c,
        (withHistory) => host.publishThread(c, withHistory),
        (withHistory) => host.publishThread(c, withHistory, publishThreadAsPrWide),
      ),
    )
  const githubId = focusedCommentGithubId()
  if (githubId) {
    items.push({
      id: 'comment-github',
      label: t('Open op GitHub'),
      hint: 'github',
      run: () => window.open(host.prUrl() + '#discussion_r' + githubId, '_blank'),
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
export function claudeChatClearConfirmCommandsFor(host, warning) {
  return withClose([
    {
      id: 'clear-claude-chat-confirm',
      label: t('Ja, toch wissen — {warning}', { warning }),
      hint: 'bevestig',
      run: () => host.clearClaudeChat(),
    },
  ])
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
export function claudeChatCommandsFor(host) {
  const shadowWarning = claudeChatShadowWarning()
  const items = [
    {
      id: 'clear-claude-chat',
      label: t('Wis Claude-gesprek'),
      hint: 'wis',
      ...(shadowWarning
        ? { children: claudeChatClearConfirmCommandsFor(host, shadowWarning) }
        : { run: () => host.clearClaudeChat() }),
    },
  ]
  // "Bewerk dit bericht" — only on a keyboard-selected OWN bubble with no
  // turn running (canEditClaudeMessage); same startEditClaudeMessage as the
  // bubble's pencil and `e`. After "Wis" on purpose: see ORDER above.
  const editable = activeClaudeMessage()
  if (canEditClaudeMessage(editable)) {
    items.push({
      id: 'edit-claude-message',
      label: t('Bewerk dit bericht'),
      hint: 'e',
      run: () => startEditClaudeMessage(editable.id),
    })
  }
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
// either still opens this exact menu (host.selectedComment()/openMenu('prComment')
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
export function prCommentCommandsFor(host) {
  const c = host.selectedComment()
  const replyItem = {
    id: 'pr-comment-reply',
    label: t('Beantwoorden'),
    hint: 'reply',
    run: () => startPrCommentReply(host.selectedComment()),
  }
  const resolveItem = isResolvedComment(c)
    ? {
        id: 'pr-comment-unresolve',
        label: t('Unresolve comment'),
        hint: 'heropen',
        run: () => {
          const sel = host.selectedComment()
          if (sel) unresolvePrCommentItem(sel)
        },
      }
    : {
        id: 'pr-comment-resolve',
        label: t('Resolve comment'),
        hint: 'resolve',
        run: async () => {
          const sel = host.selectedComment()
          if (!sel) return
          await host.afterResolve(() => resolvePrCommentItem(sel))
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
      const sel = host.selectedComment()
      if (!sel) return
      await host.deletePrComment(sel)
    },
  }
  // An AI finding (isAiComment) gets NO resolve/unresolve item at all — see
  // that helper's own doc comment. It is never "own" either, so the list is
  // simply [Beantwoorden, Verwijder]: replying stays the default, deleting
  // stays out of first place.
  // Same ownership rule as the block-scoped menu above: a foreign imported
  // comment keeps Beantwoorden/Resolve but loses Verwijder entirely.
  const items = isAiComment(c)
    ? [replyItem, deleteItem]
    : isOwnComment(c)
      ? [resolveItem, replyItem, deleteItem]
      : [replyItem, resolveItem]
  // "Bewerk bericht" edits whichever message the keyboard is currently ON in
  // this item's own thread (→/enterPrCommentThread + pct, see
  // focusedPrThreadMessage) — only for the reviewer's OWN message.
  const msg = focusedPrThreadMessage(c)
  if (isOwnMessage(msg)) {
    items.push({
      id: 'pr-comment-edit',
      label: t('Bewerk bericht'),
      hint: 'edit',
      run: () => startEditMessage(host.selectedComment(), msg),
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
    run: () => startPrCommentChat(host.selectedComment()),
  })
  if (needsPublishChoice(c))
    items.push(publishThreadCommand(c, (withHistory) => host.publishPrComment(c, withHistory)))
  // The Ignore toggle hides an index row, so it only exists where the host has
  // that index (the review tree; the QA page has none).
  if (host.ignore) {
    items.push({
      id: 'pr-comment-ignore',
      // Label is a function so it names the current state (resolveLabel/
      // snapshotCommands read it ONCE, right now, when the menu opens — see
      // that comment for why this must never become a live binding).
      label: () => (host.ignore.isIgnored() ? t('Ignore ongedaan maken') : 'Ignore'),
      hint: 'ignore',
      run: () => host.ignore.toggle(host.selectedComment()),
    })
  }
  return withClose(items)
}

// composeCommandsFor — the comment-kind menu on a composer that converts an
// AI-controle finding (home.mjs's runComposePost decides when it opens; see
// the doc comment above runComposePost there). Built fresh per open.
export function composeCommandsFor(host) {
  return withClose([
  {
    id: 'compose-post',
    label: t('Plaats comment'),
    hint: 'post',
    run: (opts) => host.composePost(opts),
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
    label: () => t('Laat Claude dit implementeren ({noun})', { noun: t(host.granNoun()) }),
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
}

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
export function replyPublishCommandsFor() {
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
  // Publishing a still-local INLINE thread creates a new inline comment on
  // GitHub — on a PR the reviewer doesn't review, that lists them under
  // Reviewers for good (see NOT_REVIEWER_COMMANDS). Then the inline items say
  // so and one more item posts only the typed reply PR-wide instead; the
  // inline reply stays the default (reviewer decision).
  const notReviewer = pendingPublishNeedsReviewerChoice()
  const asReviewer = (label) => (notReviewer ? t('{label} (je wordt reviewer)', { label }) : label)
  const items = [historyChoice('reply-publish-reply', asReviewer(t('Alleen mijn antwoord op GitHub')), 'reply')]
  if (!isChatAnchor) items.push(historyChoice('reply-publish-thread', asReviewer(rootLabel), 'thread'))
  if (notReviewer) {
    items.push({
      id: 'reply-publish-prwide',
      label: t('Alleen mijn antwoord als algemene comment (geen reviewer)'),
      hint: 'hele PR',
      run: () => sendPendingAsPrWide(),
    })
  }
  return withClose(items)
}
