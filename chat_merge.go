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
func processChatMerge(ctx context.Context, cm *chat.Module, cl claude.Client, dataDir string, arg chatMergeInput) chat.Message {
	meta, err := fetchPRMeta(ctx, arg.PR)
	if err != nil || meta.HeadRefName == "" {
		msg := chat.Message{
			ID: chatMessageID(arg.TurnID, ""), ConversationID: arg.ConversationID, PR: arg.PR,
			Role: "assistant", Kind: chat.KindError,
			Body: "Kon de PR-branch niet bepalen om naartoe te pushen.",
		}
		_ = cm.SaveMessage(ctx, msg)
		return msg
	}
	return processChatMergeAt(ctx, cm, cl, dataDir, arg, meta.HeadRefName)
}

// processChatMergeAt is processChatMerge's body once the PR's head branch
// name is already known — split out for the same testability reason as
// ensureChatShadowWorktreeAt/commitChatShadowEditsAt: no gh/network call, so a
// test can exercise the real fast-forward/merge/conflict mechanics against a
// throwaway local repo.
//
// Attempts the conversation's shadow-worktree push via the EXISTING
// commitChatShadowEditsAt (unchanged — still the sole fast-forward-only
// path), and only escalates to an automatic merge when that reports the one
// specific, named outcome "the real branch moved on"
// (chatShadowBranchMovedOnMsg) — never for any other failure (no shadow, the
// push itself failed for an unrelated reason), which are returned to the
// reviewer as-is.
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
func processChatMergeAt(ctx context.Context, cm *chat.Module, cl claude.Client, dataDir string, arg chatMergeInput, headRefName string) chat.Message {
	msg := commitChatShadowEditsAt(ctx, cm, dataDir, arg.PR, arg.ConversationID, arg.TurnID, headRefName)
	if msg.Kind != chat.KindError || msg.Body != chatShadowBranchMovedOnMsg {
		return msg
	}
	return resolveChatShadowMerge(ctx, cm, cl, dataDir, arg.PR, arg.ConversationID, arg.TurnID, headRefName)
}

// chatMergeConflictFailedMsg is shown when the one begrensde Claude attempt
// couldn't clear a real conflict — the merge is aborted (chat_shadow.go's
// "degrade rather than guess" rule), so the reviewer's next "commit" simply
// tries again from a clean shadow.
const chatMergeConflictFailedMsg = "Er ontstond een samenvoegconflict met een andere, inmiddels gepushte wijziging dat niet automatisch kon worden opgelost. Vraag Claude de wijziging opnieuw te maken op basis van de huidige branch."

// resolveChatShadowMerge runs once the plain fast-forward attempt reported the
// PR branch moved on: try an ordinary `git merge` of that (already fetched by
// commitChatShadowEditsAt) branch tip into the conversation's shadow first —
// no AI, fully deterministic — and only when that leaves real conflicts, make
// ONE begrensde Claude attempt to resolve them. Any failure aborts the merge
// (never leaves the shadow worktree mid-conflict) and degrades to a
// reviewer-facing message; success pushes via the same
// pushAndReclaimChatShadow every fast-forward push already uses.
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

	_, mergeErr := runGitIn(ctx, dir, "merge", "origin/"+headRefName, "-m", "Merge remote-tracking branch for chat edit")
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
		// files/regions of the same conversation's edit vs. the other one) — no
		// AI needed at all.
		if err := pushAndReclaimChatShadow(ctx, dir, conversationID, headRefName); err != nil {
			return newMsg(chatShadowBranchMovedOnMsg, true)
		}
		return newMsg(fmt.Sprintf("Wijziging gepusht naar `%s` (automatisch samengevoegd met een andere wijziging).", headRefName), false)
	}

	// A real conflict — exactly one begrensde Claude-poging, never more.
	if !resolveConflictWithClaude(ctx, cl, dir, conversationID, conflicted) {
		_, _ = runGitIn(ctx, dir, "merge", "--abort")
		return newMsg(chatMergeConflictFailedMsg, true)
	}
	if _, err := runGitIn(ctx, dir, "add", "-A"); err != nil {
		_, _ = runGitIn(ctx, dir, "merge", "--abort")
		return newMsg(chatMergeConflictFailedMsg, true)
	}
	if _, err := runGitIn(ctx, dir, "commit", "--no-edit"); err != nil {
		_, _ = runGitIn(ctx, dir, "merge", "--abort")
		return newMsg(chatMergeConflictFailedMsg, true)
	}
	if err := pushAndReclaimChatShadow(ctx, dir, conversationID, headRefName); err != nil {
		// The merge itself is already committed locally at this point (an abort
		// is no longer possible/meaningful) — a further race is rare enough that
		// degrading to the ordinary retry message is acceptable; the next
		// "commit" click re-queues a fresh request that will simply re-merge
		// against the newer tip.
		return newMsg(chatShadowBranchMovedOnMsg, true)
	}
	return newMsg(fmt.Sprintf("Wijziging gepusht naar `%s` (samenvoegconflict met een andere wijziging automatisch opgelost door Claude).", headRefName), false)
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
