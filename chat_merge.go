// chat_merge.go — the chat_merge workflow: a per-PR queue that serializes
// "commit deze wijziging" pushes across every claude_chat conversation of one
// PR, so two conversations landing changes around the same time are merged
// ONE AFTER ANOTHER instead of racing each other's fast-forward-only push (see
// chat_shadow.go and .claude/docs/tembed-workflows.md, "chat_merge").
//
// Serialization is not custom queue code: one Execution per PR, looping on a
// "merge" Signal, reuses tembed's own per-Run-ID mutex (Engine.SignalWorkflow
// runs a run's Activities inline, under its runLock) to process that PR's
// commit requests strictly in arrival order — exactly the mould of
// approveWorkflow/ignoreCommentWorkflow. The workflow body itself calls
// exactly ONE Activity per Signal, so the number/order of Activities stays a
// pure function of how many "merge" Signals arrived, never of what that
// Activity discovers live (fast-forward possible? merge needed? a real
// conflict?) — see .claude/rules/workflow-determinism.md.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/reindert-vetter/tembed"
	"slash/modules/chat"
	"slash/modules/claude"
)

// WorkflowChatMerge is the Workflow Type: one Execution per PR (see
// chatMergeQueueRunID). Never started directly from the UI — only ensured
// from inside claudeChatWorkflow's own "commit" Activity (enqueueChatMerge),
// mirroring how reanchorAfterRefresh ensures+signals the approve tracker from
// inside a DIFFERENT workflow's Activity (workflows.go).
const WorkflowChatMerge = "chat_merge"

// SignalChatMerge delivers one conversation's commit request to the PR's
// chat_merge queue.
const SignalChatMerge = "merge"

// The two ChatMergeRequest.Action values. A second Signal NAME would need a
// WaitSignal that can wait on either name, which tembed deliberately doesn't
// have (one name per WaitSignal, no select in a workflow body — see
// .claude/rules/workflow-determinism.md), so the action rides along as a
// variant of the same Signal exactly like ChatMessageSignal.Action and
// ReactionSignal.Action already do.
const (
	chatMergeActionLand = ""     // land one conversation's edit (the default)
	chatMergeActionPush = "push" // push the PR's pending ref to GitHub
)

// ChatMergeQueueInput starts (or, idempotently, re-ensures) the chat_merge
// Execution for one PR.
type ChatMergeQueueInput struct {
	PR int `json:"pr"`
}

// ChatMergeRequest is the "merge" Signal's payload — one conversation's commit
// request. TurnID is the ORIGINAL "commit" ChatMessageSignal's own id
// (forwarded by enqueueChatMerge), so the outcome message this queue writes
// derives its id the same deterministic way every other chat message does
// (chatMessageID) — replay-safe even though the request now crosses two
// Workflow Executions.
type ChatMergeRequest struct {
	ConversationID string `json:"conversationId"`
	TurnID         string `json:"turnId,omitempty"`
	// Action selects what this request is (see chatMergeActionLand/Push). Empty
	// means "land this conversation's edit", so every existing sender keeps
	// working unchanged. A "push" request carries no conversation at all: it is
	// about the PR's pending ref, and it comes straight from the reviewer's todo
	// row rather than from a chat turn.
	Action string `json:"action,omitempty"`
}

// chatMergeQueueRunID derives the chat_merge Execution's Run ID from the PR
// number — deterministic, like chatConversationRunID, so StartWorkflowID makes
// ensuring it idempotent with no extra in-memory bookkeeping (unlike
// EnsureApprovals/EnsureIgnoreComment, whose workflows predate this
// deterministic-id convention and therefore cache a random Run ID instead).
func chatMergeQueueRunID(pr int) string {
	return fmt.Sprintf("chatmerge-%d", pr)
}

// EnsureChatMergeQueue ensures the chat_merge Execution for pr exists
// (idempotent via StartWorkflowID) and returns its Run ID. Called only from
// enqueueChatMerge — a cross-workflow Ensure+Signal from inside another
// Workflow's Activity, the same shape reanchorAfterRefresh already uses for
// the approve tracker (workflows.go).
func (m *TaskManager) EnsureChatMergeQueue(pr int) (string, error) {
	return m.engine.StartWorkflowID(chatMergeQueueRunID(pr), WorkflowChatMerge, ChatMergeQueueInput{PR: pr})
}

// chatMergeQueueWorkflow is the durable definition. Never completes — a
// long-lived per-PR tracker, mould of approveWorkflow/ignoreCommentWorkflow.
// Marked PriorityLow (see workflows.go) for the same reason claude_chat is: an
// interrupted conflict-resolution Activity is a real claude subprocess call
// and must not block server startup on recovery.
func chatMergeQueueWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ChatMergeQueueInput
	_ = json.Unmarshal(input, &in)
	for {
		var req ChatMergeRequest
		w.WaitSignal(SignalChatMerge, &req)
		// Which branch runs is decided purely by the Signal's own recorded
		// payload, so it is a pure function of the history — the same shape
		// claudeChatWorkflow's own Action branches have.
		if req.Action == chatMergeActionPush {
			if err := w.ExecuteActivity("pushPendingPR", chatMergeInput{PR: in.PR}, nil); err != nil {
				return nil, fmt.Errorf("push pending pr: %w", err)
			}
			continue
		}
		if err := w.ExecuteActivity("processChatMerge", chatMergeInput{
			PR: in.PR, ConversationID: req.ConversationID, TurnID: req.TurnID,
		}, nil); err != nil {
			return nil, fmt.Errorf("process chat merge: %w", err)
		}
	}
}

// chatMergeInput is the processChatMerge Activity's own input.
type chatMergeInput struct {
	PR             int    `json:"pr"`
	ConversationID string `json:"conversationId"`
	TurnID         string `json:"turnId,omitempty"`
}

// enqueueChatMerge is the enqueueChatMerge Activity's body — it REPLACES the
// old direct commitChatShadowEdits call in claudeChatWorkflow's
// chatActionCommit branch: ensure the PR's chat_merge queue exists and hand it
// this conversation's commit request, then return immediately. Best-effort/
// log-only on failure (mirrors reanchorAfterRefresh's own cross-workflow
// Ensure+Signal calls) — a queue that can't be reached (an engine hiccup) must
// not fail the whole claude_chat Execution; the reviewer simply sees no
// outcome message yet and can press "commit" again.
//
// Deliberately asynchronous relative to the ORIGINAL "commit" message Signal:
// the actual git/Claude work now happens on the PR's shared queue, which may
// be processing another conversation's request first (that is the whole
// point — see the file header). The outcome is recorded as its own chat
// message once processChatMerge finishes and reaches this conversation's
// transcript over the same publishChatChanged/SSE path every other chat
// Activity already uses — never returned synchronously from this Activity.
func enqueueChatMerge(tm *TaskManager, arg chatCommitInput) {
	runID, err := tm.EnsureChatMergeQueue(arg.PR)
	if err != nil {
		tm.logf("chat_merge: no queue for pr %d: %v", arg.PR, err)
		return
	}
	if err := tm.engine.SignalWorkflow(runID, SignalChatMerge, ChatMergeRequest{
		ConversationID: arg.ConversationID, TurnID: arg.TurnID,
	}); err != nil {
		tm.logf("chat_merge: signal pr %d conversation %s: %v", arg.PR, arg.ConversationID, err)
	}
}

// processChatMerge is the processChatMerge Activity's body: resolve the PR's
// real head branch name (the one gh/network call in this whole path) and
// delegate to processChatMergeAt.
func processChatMerge(ctx context.Context, tm *TaskManager, cm *chat.Module, cl claude.Client, dataDir string, arg chatMergeInput) chat.Message {
	meta, err := fetchPRMeta(ctx, arg.PR)
	if err != nil || meta.HeadRefName == "" {
		msg := chat.Message{
			ID: chatMessageID(arg.TurnID, ""), ConversationID: arg.ConversationID, PR: arg.PR,
			Role: "assistant", Kind: chat.KindError,
			Body: "Kon de PR-branch niet bepalen om de wijziging op te landen.",
		}
		_ = cm.SaveMessage(ctx, msg)
		return msg
	}
	return processChatMergeAt(ctx, tm, cm, cl, dataDir, arg, meta.HeadRefName)
}

// processChatMergeAt is processChatMerge's body once the PR's head branch
// name is already known — split out for the same testability reason as
// ensureChatShadowWorktreeAt/commitChatShadowEditsAt: no gh/network call, so a
// test can exercise the real fast-forward/merge/conflict mechanics against a
// throwaway local repo.
//
// Attempts the conversation's landing via the EXISTING commitChatShadowEditsAt
// (unchanged — still the sole fast-forward-only path), and only escalates to an
// automatic merge when that reports the one specific, named outcome "the branch
// moved on" (chatShadowBranchMovedOnMsg) — never for any other failure (no
// shadow, the landing failed for an unrelated reason), which are returned to
// the reviewer as-is.
//
// A successful landing additionally asks the PR's own tracker to refresh the
// review tree (refreshTreeAfterLanding), so the code the reviewer just had
// changed is visible in the blocks/diff right away instead of only after the
// eventual push.
//
// Bounded to exactly one merge/resolve attempt: if the branch moves on AGAIN
// while resolving, this degrades to the ordinary "ververs en probeer opnieuw"
// message rather than looping — the reviewer's own retry (a fresh "commit"
// click) re-queues a brand new request. This keeps the Activity a bounded,
// deterministic sequence of steps regardless of how much the branch thrashes.
//
// Every outcome is recorded as ONE chat.Message under the SAME deterministic
// id commitChatShadowEditsAt already wrote (chatMessageID(arg.TurnID, "")), so
// this function's own follow-up SaveMessage calls simply overwrite that row
// rather than adding a second one — the reviewer only ever sees the final
// outcome, never the transient "moved on" text this uses internally as a
// detection signal.
func processChatMergeAt(ctx context.Context, tm *TaskManager, cm *chat.Module, cl claude.Client, dataDir string, arg chatMergeInput, headRefName string) chat.Message {
	msg := commitChatShadowEditsAt(ctx, cm, dataDir, arg.PR, arg.ConversationID, arg.TurnID, headRefName)
	if msg.Kind == chat.KindError && msg.Body == chatShadowBranchMovedOnMsg {
		msg = resolveChatShadowMerge(ctx, cm, cl, dataDir, arg.PR, arg.ConversationID, arg.TurnID, headRefName)
	}
	if msg.Kind != chat.KindError {
		refreshTreeAfterLanding(ctx, tm, arg.PR, headRefName)
		// The landing created (or advanced) the PR's pending ref, so the todo row
		// at the bottom of the block index has something new to show.
		publishPendingPushChanged(arg.PR)
	}
	return msg
}

// refreshTreeAfterLanding makes a just-landed chat edit visible in the review
// tree immediately: it signals the PR's own pr_status tracker with the pending
// ref's new commit as the head SHA, which runs the ordinary ingest-refresh
// branch (refreshIngestDelta + the re-anchor pass + the relations/code_warning
// rebuild — see prStatusWorkflow). Nothing about that branch cares whether the
// head SHA is on GitHub yet; it only needs a locally reachable commit, which a
// landed commit is by definition.
//
// Cross-workflow Ensure+Signal from inside an Activity, best-effort/log-only on
// failure — the same shape enqueueChatMerge and reanchorAfterRefresh already
// use. A missed refresh costs nothing durable: pollIngestRefresh re-observes
// the same state on its next tick.
//
// The BASE SHA is deliberately the one already recorded for this PR, so the
// refresh stays an incremental delta instead of falling back to a full ingest
// (refreshIngestDelta compares the two). No prior ingest at all → nothing to
// refresh yet, so this is a no-op.
func refreshTreeAfterLanding(ctx context.Context, tm *TaskManager, pr int, headRefName string) {
	if tm == nil || tm.engine == nil || tm.db == nil {
		return // tests / a manager without an engine or graph DB
	}
	sha := pendingRefSHA(ctx, prPendingRef(pr, headRefName))
	if sha == "" {
		return
	}
	base, _, ok, err := loadIngestSHAs(tm.db, pr)
	if err != nil || !ok {
		return
	}
	runID, err := tm.EnsurePRStatus(pr)
	if err != nil {
		tm.logf("chat_merge: no pr_status tracker for pr %d: %v", pr, err)
		return
	}
	if err := tm.engine.SignalWorkflow(runID, SignalPRState, PRStateSignal{BaseSHA: base, HeadSHA: sha}); err != nil {
		tm.logf("chat_merge: signal ingest refresh after landing pr %d: %v", pr, err)
	}
}

// chatMergeConflictConsultMsg is what a conflict the one begrensde Claude
// attempt couldn't clear turns into: not a dead end, but a message that opens a
// CONSULTATION in the very conversation the edit came from.
//
// It lands in that conversation's own transcript (same deterministic message id
// as every other outcome, see processChatMergeAt), so the reviewer reads it in
// the Claude column and answers it there — his reply is an ordinary chat turn
// and Claude can redo the change against the current state of the branch. That
// is why the body has to carry the facts a reply needs: which tip conflicted,
// which files, and what has already been tried. The merge itself is aborted
// first (chat_shadow.go's "degrade rather than guess" rule), so nothing is left
// half-merged while the two of them figure it out.
//
// Markdown, like every chat bubble (renderMarkdown, see conventions.md), so the
// file list reads as a real list.
func chatMergeConflictConsultMsg(ref, headRefName string, conflicted []string) string {
	origin := "een andere, inmiddels op GitHub gepushte wijziging"
	if strings.HasPrefix(ref, "refs/slash/pending/") {
		origin = "een andere wijziging die al op `" + headRefName + "` staat maar nog niet gepusht is"
	}
	var b strings.Builder
	b.WriteString("**Samenvoegconflict — hier wil ik even met je overleggen.**\n\n")
	b.WriteString("Jouw wijziging botst met " + origin + ". Ik heb `git merge` geprobeerd en daarna één poging gedaan om het conflict zelf op te lossen; dat is niet gelukt, dus ik heb de merge afgebroken (er staat niets half samengevoegd).\n\n")
	b.WriteString("Conflicterende bestanden:\n\n")
	for _, p := range conflicted {
		b.WriteString("- `" + p + "`\n")
	}
	b.WriteString("\nHoe wil je verder? Zeg bijvoorbeeld welke kant voorrang heeft, of vraag me de wijziging opnieuw te maken op de huidige stand van `" + headRefName + "`.")
	return b.String()
}

// resolveChatShadowMerge runs once the plain fast-forward attempt reported the
// PR branch moved on: try an ordinary `git merge` of every tip the landing must
// contain (origin's — already fetched by commitChatShadowEditsAt — and the PR's
// pending ref) into the conversation's shadow first — no AI, fully
// deterministic — and only when that leaves real conflicts, make ONE begrensde
// Claude attempt to resolve them. Any failure aborts the merge
// (never leaves the shadow worktree mid-conflict) and degrades to a
// reviewer-facing message; success lands via the same
// landAndReclaimChatShadow every fast-forward landing already uses.
func resolveChatShadowMerge(ctx context.Context, cm *chat.Module, cl claude.Client, dataDir string, pr int, conversationID, turnID, headRefName string) chat.Message {
	newMsg := func(body string, isErr bool) chat.Message {
		kind := ""
		if isErr {
			kind = chat.KindError
		}
		msg := chat.Message{
			ID: chatMessageID(turnID, ""), ConversationID: conversationID, PR: pr,
			Role: "assistant", Kind: kind, Body: body,
		}
		_ = cm.SaveMessage(ctx, msg)
		return msg
	}

	dir := chatShadowDir(dataDir, pr, conversationID)

	// EVERY tip the landing must contain, merged one at a time in
	// chatShadowMissingTips' own fixed order (origin's tip, then the PR's
	// pending ref) — both can have moved: someone pushing to GitHub advances
	// the first, another conversation landing an unpushed edit the second.
	// Merging both is what makes divergence resolve automatically instead of
	// leaving the reviewer stuck; deliberately never a rewind of either.
	//
	// Determinism is unaffected: this is all INSIDE one Activity, so the
	// workflow still executes exactly one ExecuteActivity per "merge" Signal
	// regardless of how many tips turn out to need merging (see the file
	// header and .claude/rules/workflow-determinism.md).
	resolvedByClaude := false
	for _, ref := range chatShadowMissingTips(ctx, dir, pr, headRefName) {
		_, mergeErr := runGitIn(ctx, dir, "merge", ref, "-m", "Merge "+ref+" for chat edit")
		conflicted, statusErr := chatShadowConflictedPaths(ctx, dir)
		if statusErr != nil {
			_, _ = runGitIn(ctx, dir, "merge", "--abort")
			return newMsg(chatShadowBranchMovedOnMsg, true)
		}

		if len(conflicted) == 0 {
			if mergeErr != nil {
				// The merge command itself failed for a reason other than a real
				// conflict — bail out cleanly rather than guessing further.
				_, _ = runGitIn(ctx, dir, "merge", "--abort")
				return newMsg(chatShadowBranchMovedOnMsg, true)
			}
			// Clean merge: git resolved every changed line on its own (different
			// files/regions of this conversation's edit vs. the other one) — no
			// AI needed at all.
			continue
		}

		// A real conflict — exactly one begrensde Claude-poging per tip, never
		// more.
		if !resolveConflictWithClaude(ctx, cl, dir, conversationID, conflicted) {
			_, _ = runGitIn(ctx, dir, "merge", "--abort")
			return newMsg(chatMergeConflictConsultMsg(ref, headRefName, conflicted), true)
		}
		if _, err := runGitIn(ctx, dir, "add", "-A"); err != nil {
			_, _ = runGitIn(ctx, dir, "merge", "--abort")
			return newMsg(chatMergeConflictConsultMsg(ref, headRefName, conflicted), true)
		}
		if _, err := runGitIn(ctx, dir, "commit", "--no-edit"); err != nil {
			_, _ = runGitIn(ctx, dir, "merge", "--abort")
			return newMsg(chatMergeConflictConsultMsg(ref, headRefName, conflicted), true)
		}
		resolvedByClaude = true
	}

	if err := landAndReclaimChatShadow(ctx, dir, pr, conversationID, headRefName); err != nil {
		// The merge itself is already committed locally at this point (an abort
		// is no longer possible/meaningful) — a further race is rare enough that
		// degrading to the ordinary retry message is acceptable; the next
		// "commit" click re-queues a fresh request that will simply re-merge
		// against the newer tip.
		return newMsg(chatShadowBranchMovedOnMsg, true)
	}
	if resolvedByClaude {
		return newMsg(pendingLandedMsg(headRefName)+" (Samenvoegconflict met een andere wijziging automatisch opgelost door Claude.)", false)
	}
	return newMsg(pendingLandedMsg(headRefName)+" (Automatisch samengevoegd met een andere wijziging.)", false)
}

// resolveConflictWithClaude asks Claude, agentically and read/write-scoped to
// dir (the conversation's own disposable shadow worktree, never the shared
// head worktree), to resolve the given conflicted files, and reports whether
// the working tree is genuinely clean afterwards — it never trusts the
// model's own claim, only git's own conflict list (chatShadowConflictedPaths).
// A one-shot Run (not RunChat): this is a mechanical fix, not a turn in the
// reviewer's own conversation, so it needs no session/context of prior turns.
func resolveConflictWithClaude(ctx context.Context, cl claude.Client, dir, conversationID string, conflicted []string) bool {
	if cl == nil {
		return false
	}
	req := claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       chatConflictPrompt(conversationID, conflicted),
		WorkDir:      dir,
		Tools:        []string{"Read", "Grep", "Glob", "Edit"},
		SystemPrompt: claude.ChatConflictSystemPrompt,
	}
	if _, err := cl.Run(ctx, req); err != nil {
		return false
	}
	remaining, err := chatShadowConflictedPaths(ctx, dir)
	if err != nil {
		return false
	}
	return len(remaining) == 0
}

// chatConflictPrompt is the call-specific half of the conflict-resolution
// prompt (the static instructions live in claude.ChatConflictSystemPrompt) —
// mirrors every other <action>Prompt function (resolvePrompt/explainPrompt/
// warningPrompt).
func chatConflictPrompt(conversationID string, conflicted []string) string {
	return fmt.Sprintf(
		"Er is een samenvoegconflict ontstaan tussen de wijziging van chat-conversatie %s en een andere, "+
			"inmiddels op de PR-branch gepushte wijziging. De volgende bestanden bevatten conflictmarkers "+
			"(<<<<<<<, =======, >>>>>>>):\n\n%s\n",
		conversationID, strings.Join(conflicted, "\n"),
	)
}
