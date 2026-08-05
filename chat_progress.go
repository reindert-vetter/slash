// chat_progress.go — "what is Claude doing right now" for one running
// claude_chat turn: a purely in-memory snapshot per conversation, updated from
// the streamed CLI events (modules/claude's RunRequest.OnEvent, wired up in
// runOneClaudeTurn) and pushed to the browser over SSE (eventbus.go).
//
// Same carve-out as ingest_progress.go: it never touches a module,
// read-model or workflow history, and it is empty again after a restart, so it
// sits outside the workflows-write-boundary rule (see
// .claude/rules/workflows-write-boundary.md). The durable transcript is
// untouched by any of this — an intermediate fragment is by definition
// throwaway, and only the ONE chat.Message the Activity saves at the end is
// reproducible under replay (see .claude/rules/workflow-determinism.md).
//
// It exists ALONGSIDE the SSE push, not instead of it: a tab that opens (or
// reconnects) halfway through a turn has missed every event so far, and
// GET /api/chat/progress is what lets it catch up in one read.
package main

import (
	"sync"
	"time"
)

// Chat progress phases — a small vocabulary the frontend turns into one Dutch
// status line (src/ClaudeChat.mjs). The word carries the meaning; there is no
// colour-only signal.
//
// chatPhasePreparing and chatPhaseStarting used to be one undifferentiated
// "starting" phase that covered three very different things: the local
// worktree/gh prep (a few seconds), the claude CLI spawning, and the wait for
// its first token (which can run into minutes, e.g. on an API 529 overload
// the CLI retries silently). Splitting them lets the status line actually
// say which of those is happening — see runOneClaudeTurn (chat_workflow.go).
const (
	chatPhasePreparing = "preparing" // local prep: gh/git worktree refresh, before the CLI is even invoked
	chatPhaseStarting  = "starting"  // CLI session started, waiting for its first event/token
	chatPhaseThinking  = "thinking"
	chatPhaseWriting   = "writing"
	chatPhaseTool      = "tool"
)

// chatProgress is the whole volatile state of one running turn.
type chatProgress struct {
	Running bool   `json:"running"`
	Phase   string `json:"phase"`
	Tool    string `json:"tool,omitempty"`
	Detail  string `json:"detail,omitempty"`
	// Partial is the answer text produced so far this turn — what makes the
	// reply visibly stream in. Never persisted: the saved message is written
	// once, at the end, from the CLI's own final result.
	Partial   string `json:"partial,omitempty"`
	StartedAt int64  `json:"startedAt"` // unix ms
	UpdatedAt int64  `json:"updatedAt"` // unix ms
}

var (
	chatProgressMu     sync.Mutex
	chatProgressByConv = map[string]chatProgress{}
)

// nowMillis is a var purely so a test can pin the clock. Not workflow-body
// code (this runs inside an Activity/HTTP handler), so a real clock is fine.
var nowMillis = func() int64 { return time.Now().UnixMilli() }

// startChatProgress marks a turn as running and publishes that first state, so
// the reviewer sees "Werkmap klaarzetten…" the moment the turn begins rather
// than only once the CLI has actually started. The phase moves on to
// chatPhaseStarting once local prep is done — see advanceChatProgress, called
// from runOneClaudeTurn right before the claude CLI is invoked.
func startChatProgress(pr int, conversationID string) {
	now := nowMillis()
	p := chatProgress{Running: true, Phase: chatPhasePreparing, StartedAt: now, UpdatedAt: now}
	chatProgressMu.Lock()
	chatProgressByConv[conversationID] = p
	chatProgressMu.Unlock()
	publishChatProgress(pr, conversationID, p)
}

// advanceChatProgress sets phase on the running turn's snapshot and publishes
// it — the same mutate+publish pair chatProgressSink uses for every streamed
// CLI event, reused here for the one phase transition that happens OUTSIDE
// that stream (local prep finished, about to invoke the CLI). A no-op if the
// turn already finished (mirrors mutateChatProgress's own late-event guard).
func advanceChatProgress(pr int, conversationID, phase string) {
	snap, ok := mutateChatProgress(conversationID, func(p *chatProgress) {
		p.Phase = phase
	})
	if !ok {
		return
	}
	publishChatProgress(pr, conversationID, snap)
}

// mutateChatProgress applies fn to the stored snapshot and returns the result.
// The second return is false when there is no running turn for that
// conversation (a late event after the turn finished) — the caller then
// publishes nothing.
func mutateChatProgress(conversationID string, fn func(*chatProgress)) (chatProgress, bool) {
	chatProgressMu.Lock()
	defer chatProgressMu.Unlock()
	p, ok := chatProgressByConv[conversationID]
	if !ok {
		return chatProgress{}, false
	}
	fn(&p)
	p.UpdatedAt = nowMillis()
	chatProgressByConv[conversationID] = p
	return p, true
}

// finishChatProgress publishes one last snapshot with Running false — keeping
// whatever partial text was produced, so the bubble doesn't blink out before
// the real message has been refetched — and then forgets the turn. A tab that
// connects after this gets nothing from GET /api/chat/progress and simply
// renders the stored transcript, which by then holds the finished message.
func finishChatProgress(pr int, conversationID string) {
	chatProgressMu.Lock()
	p, ok := chatProgressByConv[conversationID]
	if ok {
		delete(chatProgressByConv, conversationID)
	}
	chatProgressMu.Unlock()
	if !ok {
		return
	}
	p.Running = false
	p.UpdatedAt = nowMillis()
	publishChatProgress(pr, conversationID, p)
}

// chatProgressFor returns the current snapshot of a running turn, if any.
func chatProgressFor(conversationID string) (chatProgress, bool) {
	chatProgressMu.Lock()
	defer chatProgressMu.Unlock()
	p, ok := chatProgressByConv[conversationID]
	return p, ok
}

// publishChatProgress/publishChatChanged are the two chat publishers. Kept
// here, next to the state they describe, so every push about a conversation
// goes through one pair of functions.
func publishChatProgress(pr int, conversationID string, p chatProgress) {
	events.publish(eventChatProgress, pr, conversationID, p)
}

// publishChatChanged says "this conversation's transcript changed"; the client
// refetches GET /api/chat rather than trusting a pushed payload.
func publishChatChanged(pr int, conversationID string) {
	if conversationID == "" {
		return
	}
	events.publish(eventChatMessage, pr, conversationID, nil)
}
