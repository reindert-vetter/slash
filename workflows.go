package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/comments"
	"slash/modules/github"
)

// This file wires the first task as a durable tembed Workflow. Terminology
// follows Temporal: a Workflow Type (task_code_comment) started as a Workflow
// Execution (identified by a Run ID), which drives Activities and reacts to
// Signals. The Workflow is the only writer of state; it drives two modules —
// the comments module (its own read-model store) and the github module — as
// Activities. Reactions hook onto a comment as "reply" Signals, delivered from
// both the UI and a GitHub poller.

const (
	// WorkflowTaskCodeComment is the Workflow Type; also the endpoint segment
	// POST /api/workflows/task_code_comment.
	WorkflowTaskCodeComment = "task_code_comment"
	// SignalReply is the Signal Name a reaction is delivered under.
	SignalReply = "reply"

	// pollInterval is how often the GitHub poller checks a thread for new
	// reactions.
	pollInterval = time.Minute
)

// CodeCommentInput starts a code-comment Workflow Execution.
type CodeCommentInput struct {
	PR     int    `json:"pr"`
	File   string `json:"file"`
	Line   int    `json:"line"`
	Author string `json:"author"`
	Body   string `json:"body"`
}

// ReactionSignal is the payload of a "reply" Signal — a reaction hooking onto
// the comment, from the UI or from GitHub.
type ReactionSignal struct {
	ID     string `json:"id"`
	Source string `json:"source"` // ui | github
	Author string `json:"author"`
	Body   string `json:"body"`
	Done   bool   `json:"done"` // resolves the thread
}

// postResult carries the GitHub root comment ID (0 when GitHub is unavailable).
type postResult struct {
	RootID int64 `json:"rootId"`
}

// TaskManager registers the workflow + its activities on a tembed engine and
// runs the per-execution GitHub poller.
type TaskManager struct {
	engine   *tembed.Engine
	gh       github.Client
	comments *comments.Module
	interval time.Duration
	logf     func(string, ...any)
}

// NewTaskManager wires the modules onto engine and registers the workflow.
func NewTaskManager(engine *tembed.Engine, gh github.Client, cs *comments.Module) *TaskManager {
	m := &TaskManager{engine: engine, gh: gh, comments: cs, interval: pollInterval, logf: log.Printf}

	// Activity: the comments module stores the comment (write, workflow-driven).
	engine.RegisterActivity("saveComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var c comments.Comment
		if err := json.Unmarshal(in, &c); err != nil {
			return nil, err
		}
		return nil, cs.Save(ctx, c)
	})

	// Activity: the github module posts the line comment (best-effort — a
	// failure must not sink the workflow, so local/no-gh runs still work).
	engine.RegisterActivity("postGithubComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var c CodeCommentInput
		if err := json.Unmarshal(in, &c); err != nil {
			return nil, err
		}
		id, err := gh.PostLineComment(ctx, c.PR, c.File, c.Line, c.Body)
		if err != nil {
			m.logf("task_code_comment: github post skipped: %v", err)
			return json.Marshal(postResult{RootID: 0})
		}
		return json.Marshal(postResult{RootID: id})
	})

	// Activity: the comments module stores a reaction (write, workflow-driven).
	engine.RegisterActivity("saveReaction", func(ctx context.Context, in []byte) ([]byte, error) {
		var r comments.Reaction
		if err := json.Unmarshal(in, &r); err != nil {
			return nil, err
		}
		return nil, cs.AddReaction(ctx, r)
	})

	// Activity: reply on GitHub to a UI reaction (best-effort).
	engine.RegisterActivity("replyGithub", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR     int    `json:"pr"`
			RootID int64  `json:"rootId"`
			Body   string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if _, err := gh.Reply(ctx, arg.PR, arg.RootID, arg.Body); err != nil {
			m.logf("task_code_comment: github reply skipped: %v", err)
		}
		return nil, nil
	})

	engine.RegisterWorkflow(WorkflowTaskCodeComment, taskCodeCommentWorkflow)
	return m
}

// taskCodeCommentWorkflow is the durable definition. It is deterministic: all
// side effects go through Activities and Signals.
func taskCodeCommentWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in CodeCommentInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	runID := w.RunID()

	// Store the comment (comments module) and post it (github module).
	comment := comments.Comment{
		ID: runID, RunID: runID, PR: in.PR, File: in.File, Line: in.Line,
		Author: in.Author, Body: in.Body,
	}
	if err := w.ExecuteActivity("saveComment", comment, nil); err != nil {
		return nil, fmt.Errorf("save comment: %w", err)
	}
	var posted postResult
	if err := w.ExecuteActivity("postGithubComment", in, &posted); err != nil {
		return nil, fmt.Errorf("post github comment: %w", err)
	}

	// Reactions loop: each "reply" Signal (UI or GitHub) is stored, mirrored to
	// the other side, and closes the thread when Done.
	reactions := 0
	for {
		var r ReactionSignal
		w.WaitSignal(SignalReply, &r)
		reactions++

		if err := w.ExecuteActivity("saveReaction", comments.Reaction{
			ID: r.ID, CommentID: runID, Source: r.Source, Author: r.Author, Body: r.Body, Resolves: r.Done,
		}, nil); err != nil {
			return nil, fmt.Errorf("save reaction: %w", err)
		}
		// Mirror a UI reaction onto GitHub (best-effort). GitHub-sourced
		// reactions are not echoed back.
		if r.Source == "ui" {
			_ = w.ExecuteActivity("replyGithub", map[string]any{
				"pr": in.PR, "rootId": posted.RootID, "body": r.Body,
			}, nil)
		}
		if r.Done {
			break
		}
	}
	return json.Marshal(map[string]any{"comment": runID, "reactions": reactions})
}

// StartCodeComment posts the comment (synchronously, inside StartWorkflow) and
// launches the GitHub poller. Returns the Run ID (== the comment ID).
func (m *TaskManager) StartCodeComment(ctx context.Context, in CodeCommentInput) (string, error) {
	runID, err := m.engine.StartWorkflow(WorkflowTaskCodeComment, in)
	if err != nil {
		return "", err
	}
	rootID, err := m.rootID(runID)
	if err != nil {
		return runID, err
	}
	if rootID != 0 {
		go m.poll(ctx, runID, in.PR, rootID)
	}
	return runID, nil
}

// Signal delivers a reaction Signal to a running Workflow Execution (the UI
// path: the only way the UI writes anything).
func (m *TaskManager) Signal(runID string, r ReactionSignal) error {
	return m.engine.SignalWorkflow(runID, SignalReply, r)
}

// poll checks the GitHub thread every interval and delivers each new reply as a
// "reply" Signal until the execution finishes.
func (m *TaskManager) poll(ctx context.Context, runID string, pr int, rootID int64) {
	seen := map[int64]bool{}
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			status, err := m.engine.Status(runID)
			if err != nil || status == tembed.StatusCompleted || status == tembed.StatusFailed {
				return
			}
			replies, err := m.gh.FetchReplies(ctx, pr, rootID)
			if err != nil {
				m.logf("task_code_comment: fetch replies pr=%d root=%d: %v", pr, rootID, err)
				continue
			}
			for _, r := range replies {
				if seen[r.ID] {
					continue
				}
				seen[r.ID] = true
				sig := ReactionSignal{
					ID: fmt.Sprintf("gh-%d", r.ID), Source: "github",
					Author: r.Author, Body: r.Body, Done: r.Done,
				}
				if err := m.engine.SignalWorkflow(runID, SignalReply, sig); err != nil {
					m.logf("task_code_comment: signal run=%s: %v", runID, err)
				}
			}
		}
	}
}

// rootID reads the GitHub root comment ID recorded by postGithubComment.
func (m *TaskManager) rootID(runID string) (int64, error) {
	hist, err := m.engine.History(runID)
	if err != nil {
		return 0, err
	}
	for _, ev := range hist {
		if ev.Type == tembed.EventActivityCompleted && ev.Name == "postGithubComment" {
			var pr postResult
			if err := json.Unmarshal(ev.Payload, &pr); err != nil {
				return 0, err
			}
			return pr.RootID, nil
		}
	}
	return 0, nil
}
