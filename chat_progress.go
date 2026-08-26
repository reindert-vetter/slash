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
	// chatPhaseWaiting: this turn asked for write access and is waiting for the
	// one code-turn slot (chat_write_gate.go). Reviewer request: a turn that
	// only ANSWERS may run unlimited in parallel, a turn that generates or
	// changes code runs one at a time — and it waits rather than being
	// refused, so the wait itself must be visible instead of looking like a
	// hang.
	chatPhaseWaiting = "waiting"
	// chatPhaseEscalating: the read-only first attempt answered in prose that
	// it cannot write, instead of emitting {"type":"need_write"}, and the turn
	// is escalating to the shell attempt anyway (looksLikeWriteRefusal,
	// chat_workflow.go). Reviewer decision: the detection itself stays
	// invisible ("dat hoeft de gebruiker niet te zien"), but this brief status
	// line may show — it is momentary, replaced by waiting/starting as soon as
	// the escalated call really begins.
	chatPhaseEscalating = "escalating"
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
	Partial string `json:"partial,omitempty"`
	// EditedFiles accumulates every repo-relative path an Edit/Write tool call
	// touched THIS turn (chatProgressSink) — unlike Tool/Detail, which are
	// overwritten by the next tool call, this list only grows for the
	// lifetime of the turn (reset by startChatProgress at the next turn). It
	// is what finishChatProgress hands to markChatFilesPending (chat_edit_
	// pending.go) right before the snapshot itself is cleared — the review
	// tree's own "wordt aangepast" status per block (reviewer request: "mag
	// er een status bij elk blok uit dat bestand met dat het bezig met een
	// aanpassing, dat moet weg als het is aangepast").
	EditedFiles []string `json:"editedFiles,omitempty"`
	StartedAt   int64    `json:"startedAt"` // unix ms
	UpdatedAt   int64    `json:"updatedAt"` // unix ms
	// repo/pr are unexported on purpose: they exist only so the PR-wide read
	// (runningChatProgressForPR, GET /api/chat/progress?pr=N) can filter the
	// map, and encoding/json skips them — the pushed frame's shape is
	// unchanged, and neither belongs in the snapshot the browser renders.
	repo string
	pr   int
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
func startChatProgress(repo string, pr int, conversationID string) {
	now := nowMillis()
	p := chatProgress{Running: true, Phase: chatPhasePreparing, StartedAt: now, UpdatedAt: now, repo: repo, pr: pr}
	chatProgressMu.Lock()
	chatProgressByConv[conversationID] = p
	chatProgressMu.Unlock()
	publishChatProgress(repo, pr, conversationID, p)
}

// advanceChatProgress sets phase on the running turn's snapshot and publishes
// it — the same mutate+publish pair chatProgressSink uses for every streamed
// CLI event, reused here for the one phase transition that happens OUTSIDE
// that stream (local prep finished, about to invoke the CLI). A no-op if the
// turn already finished (mirrors mutateChatProgress's own late-event guard).
func advanceChatProgress(repo string, pr int, conversationID, phase string) {
	snap, ok := mutateChatProgress(conversationID, func(p *chatProgress) {
		p.Phase = phase
	})
	if !ok {
		return
	}
	publishChatProgress(repo, pr, conversationID, snap)
}

// resetChatProgressPartial clears the accumulated Partial (and any leftover
// Tool/Detail) of a running turn's snapshot without touching Phase/
// EditedFiles/StartedAt, then publishes the cleared snapshot immediately —
// same mutate+publish pair advanceChatProgress uses. Called by
// runOneClaudeTurn (chat_workflow.go) right before invoking the SECOND
// (shell) attempt of a two-step turn: without this, the read-only first
// attempt's own answer — commonly the strict {"type":"need_write"}
// escalation directive itself, streamed into Partial like any other answer —
// stayed glued in front of the shell attempt's real text for the rest of the
// turn (reported: the live bubble showed the raw directive JSON immediately
// followed by the actual answer, no separator). A no-op if the turn already
// finished (mirrors mutateChatProgress's own late-event guard).
func resetChatProgressPartial(repo string, pr int, conversationID string) {
	snap, ok := mutateChatProgress(conversationID, func(p *chatProgress) {
		p.Partial = ""
		p.Tool, p.Detail = "", ""
	})
	if !ok {
		return
	}
	publishChatProgress(repo, pr, conversationID, snap)
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
func finishChatProgress(repo string, pr int, conversationID string) {
	chatProgressMu.Lock()
	p, ok := chatProgressByConv[conversationID]
	if ok {
		delete(chatProgressByConv, conversationID)
	}
	chatProgressMu.Unlock()
	if !ok {
		return
	}
	// Hand off whatever files this turn touched to the PR-scoped "still
	// pending" registry BEFORE the snapshot itself disappears — see
	// chat_edit_pending.go and EditedFiles' own doc comment.
	if len(p.EditedFiles) > 0 {
		markChatFilesPending(repo, pr, p.EditedFiles)
	}
	p.Running = false
	p.UpdatedAt = nowMillis()
	publishChatProgress(repo, pr, conversationID, p)
}

// chatProgressFor returns the current snapshot of a running turn, if any.
func chatProgressFor(conversationID string) (chatProgress, bool) {
	chatProgressMu.Lock()
	defer chatProgressMu.Unlock()
	p, ok := chatProgressByConv[conversationID]
	return p, ok
}

// runningChatProgressForPR returns every RUNNING turn of one PR, keyed by
// conversation id — the resync read for a tab that wants to know about the
// conversations it is NOT currently showing (a chat running on another
// selection). Per-conversation state, so a tab that reconnects mid-turn can
// rebuild its whole per-conversation picture in one call instead of only the
// one conversation it happens to have anchored.
func runningChatProgressForPR(repo string, pr int) map[string]chatProgress {
	out := map[string]chatProgress{}
	chatProgressMu.Lock()
	defer chatProgressMu.Unlock()
	for id, p := range chatProgressByConv {
		if p.pr != pr || p.repo != repo {
			continue
		}
		out[id] = p
	}
	return out
}

// publishChatProgress/publishChatChanged are the two chat publishers. Kept
// here, next to the state they describe, so every push about a conversation
// goes through one pair of functions.
func publishChatProgress(repo string, pr int, conversationID string, p chatProgress) {
	events.publish(eventChatProgress, repo, pr, conversationID, p)
}

// publishChatChanged says "this conversation's transcript changed"; the client
// refetches GET /api/chat rather than trusting a pushed payload.
func publishChatChanged(repo string, pr int, conversationID string) {
	if conversationID == "" {
		return
	}
	events.publish(eventChatMessage, repo, pr, conversationID, nil)
}
