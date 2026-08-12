// comment_batch_progress.go — "which comment is Claude working on right now,
// and which ones are already done" for one running comment_batch run: a purely
// in-memory snapshot per PR, updated from the streamed CLI events plus the
// run's own `[slash:...]` marker lines (comment_batch.go) and pushed to the
// browser over SSE (eventbus.go).
//
// Same carve-out as chat_progress.go/ingest_progress.go: it touches no module,
// read-model or workflow history, and it is empty again after a restart, so it
// sits outside the workflows-write-boundary rule (see
// .claude/rules/workflows-write-boundary.md).
//
// One difference from chat_progress.go, and it is deliberate: the snapshot is
// KEPT after the run finished (Running false), instead of being deleted. A
// batch run leaves no durable per-comment trace at all — it only edits code and
// deliberately never replies to or resolves a thread (that stays the reviewer's
// own call) — so "Claude heeft deze comment verwerkt" would otherwise vanish
// the moment the run ended. It is still throwaway state: a restart drops it and
// the reviewer simply sees the comments as ordinary open comments again.
package main

import (
	"sync"
)

// The per-comment states a batch run walks through. The word carries the
// meaning in the UI (never colour alone — the reviewer is colourblind, see
// .claude/rules/conventions.md).
const (
	commentBatchStateOpen    = "open"    // not started yet
	commentBatchStateBusy    = "busy"    // Claude announced it is working on this one
	commentBatchStateDone    = "done"    // Claude changed code for it
	commentBatchStateSkipped = "skipped" // Claude deliberately left it alone, with a reason
)

// commentBatchItem is one comment's state within the run.
type commentBatchItem struct {
	CommentID string `json:"commentId"`
	State     string `json:"state"`
	Note      string `json:"note,omitempty"`
}

// commentBatchProgress is the whole volatile state of one PR's batch run. The
// Phase/Tool/Detail trio is deliberately named exactly like chatProgress's, so
// the frontend can render it with the SAME status-line formatter it already
// uses for a Claude chat turn (claudeStatusText, src/ClaudeChat.mjs).
type commentBatchProgress struct {
	Running bool   `json:"running"`
	Total   int    `json:"total"`
	Done    int    `json:"done"`
	Skipped int    `json:"skipped"`
	Current string `json:"current,omitempty"` // comment id Claude is working on
	Phase   string `json:"phase"`
	Tool    string `json:"tool,omitempty"`
	Detail  string `json:"detail,omitempty"`

	Items     []commentBatchItem `json:"items"`
	StartedAt int64              `json:"startedAt"` // unix ms
	UpdatedAt int64              `json:"updatedAt"` // unix ms
	Error     string             `json:"error,omitempty"`
}

var (
	commentBatchMu   sync.Mutex
	commentBatchByPR = map[prKey]commentBatchProgress{}
)

// startCommentBatchProgress installs a fresh snapshot for this PR (replacing
// whatever a previous run left behind) and publishes it, so the index rows show
// "in de wachtrij" from the moment the run begins.
func startCommentBatchProgress(repo string, pr int, commentIDs []string) {
	now := nowMillis()
	items := make([]commentBatchItem, 0, len(commentIDs))
	for _, id := range commentIDs {
		items = append(items, commentBatchItem{CommentID: id, State: commentBatchStateOpen})
	}
	p := commentBatchProgress{
		Running: true, Total: len(items), Phase: chatPhasePreparing,
		Items: items, StartedAt: now, UpdatedAt: now,
	}
	commentBatchMu.Lock()
	commentBatchByPR[prKey{repo, pr}] = p
	commentBatchMu.Unlock()
	publishCommentBatchProgress(repo, pr, p)
}

// mutateCommentBatchProgress applies fn to the stored snapshot and returns the
// result. The second return is false when this PR has no snapshot at all (an
// event arriving after a restart, or for a PR that never ran a batch).
func mutateCommentBatchProgress(repo string, pr int, fn func(*commentBatchProgress)) (commentBatchProgress, bool) {
	commentBatchMu.Lock()
	defer commentBatchMu.Unlock()
	p, ok := commentBatchByPR[prKey{repo, pr}]
	if !ok {
		return commentBatchProgress{}, false
	}
	fn(&p)
	p.UpdatedAt = nowMillis()
	commentBatchByPR[prKey{repo, pr}] = p
	return p, true
}

// advanceCommentBatchProgress sets the phase (the one transition that happens
// outside the streamed events: local prep finished, CLI about to be invoked).
func advanceCommentBatchProgress(repo string, pr int, phase string) {
	if snap, ok := mutateCommentBatchProgress(repo, pr, func(p *commentBatchProgress) {
		p.Phase = phase
	}); ok {
		publishCommentBatchProgress(repo, pr, snap)
	}
}

// markCommentBatchCurrent records that Claude announced it is starting on one
// comment ([slash:start]). An id that isn't in the run's own list is ignored —
// the model must never be able to invent one.
func markCommentBatchCurrent(repo string, pr int, commentID string) {
	snap, ok := mutateCommentBatchProgress(repo, pr, func(p *commentBatchProgress) {
		for i := range p.Items {
			if p.Items[i].CommentID != commentID {
				continue
			}
			p.Current = commentID
			if p.Items[i].State == commentBatchStateOpen {
				p.Items[i].State = commentBatchStateBusy
			}
		}
	})
	if ok {
		publishCommentBatchProgress(repo, pr, snap)
	}
}

// markCommentBatchOutcome records one comment's final state ([slash:done] /
// [slash:skip]). Idempotent per comment: a second marker for the same id
// overwrites the note but never double-counts the totals.
func markCommentBatchOutcome(repo string, pr int, commentID, state, note string) {
	snap, ok := mutateCommentBatchProgress(repo, pr, func(p *commentBatchProgress) {
		for i := range p.Items {
			if p.Items[i].CommentID != commentID {
				continue
			}
			p.Items[i].State = state
			p.Items[i].Note = note
			if p.Current == commentID {
				p.Current = ""
			}
		}
		p.Done, p.Skipped = 0, 0
		for _, it := range p.Items {
			switch it.State {
			case commentBatchStateDone:
				p.Done++
			case commentBatchStateSkipped:
				p.Skipped++
			}
		}
	})
	if ok {
		publishCommentBatchProgress(repo, pr, snap)
	}
}

// failCommentBatchProgress records a run that couldn't even start (no work
// copy, CLI failure) so the reviewer reads a reason instead of a batch that
// silently never happens.
func failCommentBatchProgress(repo string, pr int, reason string) {
	if snap, ok := mutateCommentBatchProgress(repo, pr, func(p *commentBatchProgress) {
		p.Error = reason
	}); ok {
		publishCommentBatchProgress(repo, pr, snap)
	}
}

// finishCommentBatchProgress publishes one last snapshot with Running false and
// KEEPS it (see the file header): every comment Claude never reached falls back
// to "open", so a half-finished run doesn't leave rows stuck on "bezig".
func finishCommentBatchProgress(repo string, pr int) {
	if snap, ok := mutateCommentBatchProgress(repo, pr, func(p *commentBatchProgress) {
		p.Running = false
		p.Current = ""
		p.Phase, p.Tool, p.Detail = "", "", ""
		for i := range p.Items {
			if p.Items[i].State == commentBatchStateBusy {
				p.Items[i].State = commentBatchStateOpen
			}
		}
	}); ok {
		publishCommentBatchProgress(repo, pr, snap)
	}
}

// commentBatchProgressFor is the resync read behind GET /api/comment-batch.
func commentBatchProgressFor(repo string, pr int) (commentBatchProgress, bool) {
	commentBatchMu.Lock()
	defer commentBatchMu.Unlock()
	p, ok := commentBatchByPR[prKey{repo, pr}]
	return p, ok
}

// commentBatchRunning says whether this PR already has a batch in flight — the
// guard behind POST /api/workflows/comment_batch, so two clicks can't put two
// agents in the same shadow worktree at once. In-memory, so a restart lifts the
// guard; that is the same trade-off as every other volatile status here.
func commentBatchRunning(repo string, pr int) bool {
	p, ok := commentBatchProgressFor(repo, pr)
	return ok && p.Running
}

// publishCommentBatchProgress pushes the snapshot to every tab watching this PR
// (no Key: the payload is PR-wide and carries its own per-comment items).
func publishCommentBatchProgress(repo string, pr int, p commentBatchProgress) {
	events.publish(eventCommentBatchProgress, repo, pr, "", p)
}
