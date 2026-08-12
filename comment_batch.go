// comment_batch.go — "laat Claude alle openstaande comments verwerken": ONE
// agentic Opus run that walks every open comment of a PR and edits code for it.
//
// Deliberately ONE run, not one per comment (the reviewer's own framing: "dan
// moet alles in 1 agent worden opgepakt"): the comments of a single PR usually
// touch the same files and each other's context, so one session that has read
// everything once is both cheaper and better informed than N independent ones.
//
// Three product decisions that shape everything here, recorded so nobody
// "fixes" them back by accident:
//
//  1. CODE ONLY. The run never replies to a comment and never resolves one —
//     the reviewer decides that afterwards (Space on the comment's index row,
//     see spaceKey in src/home.mjs). So this workflow signals no comment
//     thread at all, unlike code_warning which creates comments of its own.
//  2. NORMAL LANDING ROUTE. The edits are made in the very same per-conversation
//     shadow worktree a Claude chat turn uses (chat_shadow.go), under the
//     synthetic conversation id commentBatchConvID(pr), and are landed by the
//     existing chat_merge queue — so they end up on the PR's local pending ref
//     and the reviewer pushes them himself from the todo row (see
//     .claude/docs/pending-push.md). No new git path whatsoever.
//  3. SKIPPING IS A FIRST-CLASS OUTCOME. A comment that is only a question, a
//     compliment, or genuinely unclear is skipped WITH a reason and the run
//     moves on; it stays an ordinary open comment for the reviewer.
//
// Per-comment progress while one agent is running comes from marker lines the
// run prints ([slash:start]/[slash:done]/[slash:skip], fixed by
// claude.CommentBatchSystemPrompt). They are parsed twice, on purpose: LIVE from
// the streamed events for the volatile progress snapshot
// (comment_batch_progress.go), and once more from the run's final text for the
// Activity's recorded result — so the durable result stays a pure function of
// that text and replay never depends on whether a stream was observed (see
// .claude/rules/workflow-determinism.md).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/reindert-vetter/tembed"

	"slash/modules/chat"
	"slash/modules/claude"
	"slash/modules/comments"
)

// CommentBatchInput is POST /api/workflows/comment_batch's body: the PR plus
// the exact comment ids the reviewer confirmed, in the order he saw them.
// Deliberately an explicit list rather than "every open comment of this PR",
// so what the agent works on is exactly what the reviewer just read in the
// palette — and so the set can't silently grow between the click and the run.
type CommentBatchInput struct {
	PR         int      `json:"pr"`
	CommentIDs []string `json:"commentIds"`
}

// commentBatchArg is the runCommentBatch Activity's input: the workflow's own
// input plus the Run ID, which doubles as the turn id every landing message of
// this run is stored under (see chatMessageID's doc comment for why that id must
// be derived, never random).
type commentBatchArg struct {
	PR         int      `json:"pr"`
	CommentIDs []string `json:"commentIds"`
	TurnID     string   `json:"turnId"`
}

// commentBatchResult is what the one agentic run reports back to the workflow.
type commentBatchResult struct {
	Done      int  `json:"done"`
	Skipped   int  `json:"skipped"`
	NeedsLand bool `json:"needsLand"`
}

// commentBatchConvID is the synthetic chat-conversation id the run's shadow
// worktree and its landing messages hang on. One per PR (never per comment): a
// single agent produces a single set of edits, which must land as one commit
// via one queue request.
func commentBatchConvID(pr int) string { return fmt.Sprintf("batch-%d", pr) }

// commentBatchWorkflow is the whole workflow: one agentic run, then — only when
// it actually left work in the shadow worktree — one hand-off to the PR's
// chat_merge queue. A fixed, input-independent sequence of at most two
// Activities, so replay is trivially deterministic.
func commentBatchWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in CommentBatchInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if in.PR <= 0 || len(in.CommentIDs) == 0 {
		return json.Marshal(commentBatchResult{})
	}
	arg := commentBatchArg{PR: in.PR, CommentIDs: in.CommentIDs, TurnID: w.RunID()}
	var res commentBatchResult
	if err := w.ExecuteActivity("runCommentBatch", arg, &res); err != nil {
		return nil, fmt.Errorf("run comment batch: %w", err)
	}
	if res.NeedsLand {
		if err := w.ExecuteActivity("enqueueChatMerge", chatCommitInput{
			PR: in.PR, ConversationID: commentBatchConvID(in.PR), TurnID: arg.TurnID,
		}, nil); err != nil {
			return nil, fmt.Errorf("enqueue comment batch merge: %w", err)
		}
	}
	return json.Marshal(res)
}

// runCommentBatch is the runCommentBatch Activity's body: the single agentic
// Claude run. Never returns an error — a failure degrades to a recorded reason
// in the volatile progress (failCommentBatchProgress) plus a zero result, like
// runCodeWarningReview, so the workflow always completes and the reviewer's
// comments are simply still open.
func runCommentBatch(ctx context.Context, tm *TaskManager, cmod *comments.Module, chatMod *chat.Module, cl claude.Client, dataDir string, arg commentBatchArg) commentBatchResult {
	if cl == nil || cmod == nil {
		return commentBatchResult{}
	}
	items := commentBatchTargets(ctx, cmod, arg)
	if len(items) == 0 {
		return commentBatchResult{}
	}

	ids := make([]string, 0, len(items))
	for _, c := range items {
		ids = append(ids, c.ID)
	}
	startCommentBatchProgress(arg.PR, ids)
	defer finishCommentBatchProgress(arg.PR)

	convID := commentBatchConvID(arg.PR)
	// The landing path (chat_merge → commitChatShadowEditsAt) records its
	// outcome as a chat.Message on this conversation, so the row has to exist.
	if chatMod != nil {
		if err := chatMod.EnsureConversation(ctx, convID, arg.PR); err != nil && tm != nil && tm.logf != nil {
			tm.logf("comment_batch pr %d: ensure conversation: %v", arg.PR, err)
		}
	}

	dir, ok := prepareChatShellWorkDir(ctx, tm, dataDir, arg.PR, convID)
	if !ok {
		failCommentBatchProgress(arg.PR, "Kon geen werkkopie klaarzetten (gh/git niet bereikbaar).")
		return commentBatchResult{}
	}

	advanceCommentBatchProgress(arg.PR, chatPhaseStarting)
	result, err := cl.RunChat(ctx, claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       commentBatchPrompt(items),
		SystemPrompt: claude.CommentBatchSystemPrompt,
		WorkDir:      dir,
		Tools:        []string{"Read", "Grep", "Glob", "Edit", "Bash"},
		OnEvent:      commentBatchProgressSink(arg.PR, ids),
	})
	if err != nil {
		failCommentBatchProgress(arg.PR, "Claude kon de comments niet verwerken. Probeer het opnieuw.")
		return commentBatchResult{}
	}

	// The recorded result comes from the final text only (see the file header),
	// and every marker is checked against the ids this run was actually given.
	allowed := make(map[string]bool, len(ids))
	for _, id := range ids {
		allowed[id] = true
	}
	res := commentBatchResult{}
	seen := map[string]bool{}
	for _, m := range parseCommentBatchMarkers(result.Text) {
		if !allowed[m.CommentID] || seen[m.CommentID] {
			continue
		}
		switch m.Kind {
		case commentBatchStateDone:
			seen[m.CommentID] = true
			res.Done++
		case commentBatchStateSkipped:
			seen[m.CommentID] = true
			res.Skipped++
		}
		markCommentBatchOutcome(arg.PR, m.CommentID, m.Kind, m.Note)
	}
	res.NeedsLand = chatShadowNeedsLanding(ctx, dataDir, arg.PR, convID)
	return res
}

// commentBatchTargets loads the comments the run may work on, in the order the
// reviewer confirmed them. Read-only, and it re-applies the same rules the
// endpoint already checked (still open, not an AI finding) — the list was built
// in the browser and a comment can have been resolved since.
func commentBatchTargets(ctx context.Context, cmod *comments.Module, arg commentBatchArg) []comments.Comment {
	list, err := cmod.List(ctx, arg.PR)
	if err != nil {
		return nil
	}
	byID := make(map[string]comments.Comment, len(list))
	for _, c := range list {
		byID[c.ID] = c
	}
	out := make([]comments.Comment, 0, len(arg.CommentIDs))
	for _, id := range arg.CommentIDs {
		c, ok := byID[id]
		if !ok || !commentBatchEligible(c) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// commentBatchEligible is the one place the "which comments may a batch touch"
// rule lives: an open comment that is not an AI finding of our own. Mirrored in
// the frontend's own list (batchCommentTargets, src/home.mjs) — the reviewer
// asked for "van GitHub + eigen, geen AI".
func commentBatchEligible(c comments.Comment) bool {
	return c.Status != "resolved" && c.Source != "ai" && c.Kind != "ai_warning"
}

// commentBatchPrompt lists the comments for the run. Only the call-specific
// content lives here; every instruction (including the marker contract) sits in
// the cacheable system prompt, per RunRequest.SystemPrompt's own doc comment.
func commentBatchPrompt(items []comments.Comment) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Verwerk deze %d openstaande reviewopmerkingen, in deze volgorde.\n", len(items))
	for i, c := range items {
		fmt.Fprintf(&b, "\n--- comment %d van %d ---\nid: %s\n", i+1, len(items), c.ID)
		if c.File != "" {
			fmt.Fprintf(&b, "bestand: %s", c.File)
			if c.Line > 0 {
				fmt.Fprintf(&b, ":%d", c.Line)
			}
			b.WriteString("\n")
		}
		if c.Label != "" {
			fmt.Fprintf(&b, "code-eenheid: %s\n", c.Label)
		}
		if c.Kind != "" {
			b.WriteString("let op: dit is een PR-brede opmerking zonder vaste regel\n")
		}
		if c.AnchorState == comments.AnchorOrphan {
			b.WriteString("let op: de code waar deze opmerking op stond is verdwenen uit de PR\n")
		}
		fmt.Fprintf(&b, "van: %s\nopmerking:\n%s\n", commentBatchAuthor(c), strings.TrimSpace(c.Body))
		for _, r := range c.Reactions {
			fmt.Fprintf(&b, "reactie van %s: %s\n", commentBatchAuthorName(r.Author), strings.TrimSpace(r.Body))
		}
		if snippet := strings.TrimSpace(c.Code); snippet != "" {
			fmt.Fprintf(&b, "code waar de opmerking op staat:\n%s\n", snippet)
		}
	}
	return b.String()
}

func commentBatchAuthor(c comments.Comment) string { return commentBatchAuthorName(c.Author) }

// commentBatchAuthorName keeps an empty author readable in the prompt — a
// comment placed in this app stores no author name at all.
func commentBatchAuthorName(author string) string {
	if strings.TrimSpace(author) == "" {
		return "de reviewer"
	}
	return author
}

// commentBatchMarker is one parsed progress marker line.
type commentBatchMarker struct {
	Kind      string // commentBatchStateBusy (start) | Done | Skipped
	CommentID string
	Note      string
}

// commentBatchMarkerRe matches the three marker lines the system prompt fixes.
// Tolerant about surrounding whitespace and a trailing note, strict about the
// tag itself — anything else in the answer is ordinary prose.
var commentBatchMarkerRe = regexp.MustCompile(`(?m)^[ \t>*-]*\[slash:(start|done|skip)\][ \t]+(\S+)[ \t]*([^\r\n]*)$`)

// parseCommentBatchMarkers extracts every marker from a piece of the answer, in
// order of appearance.
func parseCommentBatchMarkers(text string) []commentBatchMarker {
	matches := commentBatchMarkerRe.FindAllStringSubmatch(text, -1)
	out := make([]commentBatchMarker, 0, len(matches))
	for _, m := range matches {
		kind := commentBatchStateBusy
		switch m[1] {
		case "done":
			kind = commentBatchStateDone
		case "skip":
			kind = commentBatchStateSkipped
		}
		out = append(out, commentBatchMarker{
			Kind:      kind,
			CommentID: strings.Trim(m[2], "`'\"*"),
			Note:      strings.TrimSpace(m[3]),
		})
	}
	return out
}

// commentBatchProgressSink builds the OnEvent callback that maps the streamed
// CLI events onto the run's volatile progress snapshot: the same phase/tool
// mapping as chatProgressSink, plus the marker lines that move a single comment
// from "wacht" to "bezig" to "verwerkt" while the one agent is still running.
//
// Text deltas arrive mid-line, so they are buffered and only COMPLETE lines are
// scanned; the tail is kept for the next delta. Called serially from RunChat's
// own single reader goroutine, so the captured buffer needs no lock.
func commentBatchProgressSink(pr int, ids []string) func(claude.ChatEvent) {
	allowed := make(map[string]bool, len(ids))
	for _, id := range ids {
		allowed[id] = true
	}
	var buf string
	return func(ev claude.ChatEvent) {
		switch ev.Kind {
		case claude.ChatEventText:
			buf += ev.TextDelta
			cut := strings.LastIndexByte(buf, '\n')
			if cut < 0 {
				return
			}
			lines, rest := buf[:cut+1], buf[cut+1:]
			buf = rest
			for _, m := range parseCommentBatchMarkers(lines) {
				if !allowed[m.CommentID] {
					continue
				}
				if m.Kind == commentBatchStateBusy {
					markCommentBatchCurrent(pr, m.CommentID)
					continue
				}
				markCommentBatchOutcome(pr, m.CommentID, m.Kind, m.Note)
			}
		case claude.ChatEventThinking:
			if snap, ok := mutateCommentBatchProgress(pr, func(p *commentBatchProgress) {
				p.Phase, p.Tool, p.Detail = chatPhaseThinking, "", ""
			}); ok {
				publishCommentBatchProgress(pr, snap)
			}
		case claude.ChatEventTool:
			if snap, ok := mutateCommentBatchProgress(pr, func(p *commentBatchProgress) {
				p.Phase, p.Tool = chatPhaseTool, ev.Tool
				if ev.Detail != "" {
					p.Detail = ev.Detail
				}
			}); ok {
				publishCommentBatchProgress(pr, snap)
			}
		}
	}
}

// StartCommentBatch launches a comment_batch Execution for one PR. Starting an
// Execution is the sanctioned write path; StartWorkflowDeferLow so the HTTP
// request returns as soon as the run reaches its (PriorityLow) Claude Activity
// instead of holding the browser for the whole agentic run.
func (m *TaskManager) StartCommentBatch(in CommentBatchInput) (string, error) {
	if m.engine == nil {
		return "", fmt.Errorf("no engine")
	}
	return m.engine.StartWorkflowDeferLow(WorkflowCommentBatch, in)
}
