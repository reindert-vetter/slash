package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/inbox"
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
	// WorkflowPRStatus is the Workflow Type of the per-PR lifecycle tracker: one
	// Execution per PR, completing once the PR is merged or closed. It is the
	// durable record the comment pollers read to stop.
	WorkflowPRStatus = "pr_status"
	// WorkflowPRInbox is the Workflow Type that owns the PR inbox: one Execution
	// per repo. Each "refresh" Signal drives an Activity that fetches the inbox
	// from GitHub and writes it into the inbox read-model. It is the only path
	// that reads GitHub for the overview — the HTTP handlers read the read-model.
	WorkflowPRInbox = "pr_inbox"
	// SignalReply is the Signal Name a reaction is delivered under.
	SignalReply = "reply"
	// SignalPRState is the Signal Name the poller delivers an observed PR state
	// under to the pr_status tracker.
	SignalPRState = "state"
	// SignalRefresh asks the pr_inbox workflow to re-fetch the inbox now (sent by
	// the UI on page load and by the poller on its cadence).
	SignalRefresh = "refresh"

	// pollInterval is the fast cadence the GitHub poller uses while the reviewer
	// is actively viewing the thread (a heartbeat arrived within heartbeatWindow).
	pollInterval = time.Minute
	// idlePollInterval is the slow cadence once no heartbeat has arrived within
	// heartbeatWindow. Only on this slow cadence does the poller also check
	// whether the PR is merged/closed (and then stop).
	idlePollInterval = 10 * time.Minute
	// heartbeatWindow is how recent the last heartbeat must be to keep the fast
	// cadence; older than this and the poller backs off to idlePollInterval.
	heartbeatWindow = 10 * time.Minute
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

// PRStatusInput starts a pr_status Workflow Execution — one tracker per PR.
type PRStatusInput struct {
	PR int `json:"pr"`
}

// PRStateSignal carries an observed PR state into the pr_status tracker
// ("open" | "merged" | "closed").
type PRStateSignal struct {
	State string `json:"state"`
}

// PRInboxInput starts the pr_inbox Workflow Execution for a repo.
type PRInboxInput struct {
	Repo string `json:"repo"`
}

// inboxRefreshResult is the small summary the refreshInbox Activity returns — the
// actual data lives in the inbox read-model, so the event history stays compact
// even though this workflow refreshes indefinitely.
type inboxRefreshResult struct {
	UpdatedAt string `json:"updatedAt"`
	PRs       int    `json:"prs"`
}

// TaskManager registers the workflows + their activities on a tembed engine and
// runs the per-execution GitHub poller.
type TaskManager struct {
	engine   *tembed.Engine
	gh       github.Client
	comments *comments.Module
	inbox    *inbox.Module
	db       *sql.DB
	repo     string
	interval time.Duration // fast cadence (reviewer active)
	idle     time.Duration // slow cadence + PR-state check (reviewer idle)
	logf     func(string, ...any)

	mu       sync.Mutex           // guards lastBeat + prRuns + inboxRun
	lastBeat map[string]time.Time // code-comment/inbox Run ID → last heartbeat
	prRuns   map[int]string       // PR → pr_status Run ID
	inboxRun string               // pr_inbox Run ID (one per repo/process)
}

// NewTaskManager wires the modules onto engine and registers the workflows.
func NewTaskManager(engine *tembed.Engine, gh github.Client, cs *comments.Module, ib *inbox.Module, db *sql.DB, repo string) *TaskManager {
	m := &TaskManager{
		engine: engine, gh: gh, comments: cs, inbox: ib, db: db, repo: repo,
		interval: pollInterval, idle: idlePollInterval,
		lastBeat: map[string]time.Time{}, prRuns: map[int]string{},
		logf: log.Printf,
	}

	// Activity: fetch the inbox from GitHub and store it in the read-model
	// (write, workflow-driven). Best-effort: on a fetch failure we keep the last
	// good snapshot so the workflow never fails on a transient GitHub hiccup.
	engine.RegisterActivity("refreshInbox", func(ctx context.Context, in []byte) ([]byte, error) {
		snap, err := buildInboxSnapshot(ctx, m.db)
		if err != nil {
			m.logf("pr_inbox: refresh skipped: %v", err)
			return json.Marshal(inboxRefreshResult{})
		}
		sections, _ := json.Marshal(snap.Sections)
		statuses, _ := json.Marshal(snap.Statuses)
		updatedAt := time.Now().UTC().Format(time.RFC3339)
		if err := m.inbox.Save(ctx, inbox.Snapshot{
			Repo: m.repo, GeneratedFor: snap.GeneratedFor, UpdatedAt: updatedAt,
			Sections: sections, Statuses: statuses,
		}); err != nil {
			return nil, fmt.Errorf("save inbox: %w", err)
		}
		n := 0
		for _, s := range snap.Sections {
			n += len(s.PRs)
		}
		return json.Marshal(inboxRefreshResult{UpdatedAt: updatedAt, PRs: n})
	})

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
	engine.RegisterWorkflow(WorkflowPRStatus, prStatusWorkflow)
	engine.RegisterWorkflow(WorkflowPRInbox, prInboxWorkflow)
	return m
}

// prInboxWorkflow owns the PR inbox for a repo. It is deterministic: each
// "refresh" Signal drives one refreshInbox Activity (the only GitHub read for
// the overview, which writes the read-model). It never completes — a long-lived
// tracker that re-fetches whenever signalled.
func prInboxWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	for {
		var s json.RawMessage
		w.WaitSignal(SignalRefresh, &s)
		var res inboxRefreshResult
		if err := w.ExecuteActivity("refreshInbox", PRInboxInput{}, &res); err != nil {
			return nil, fmt.Errorf("refresh inbox: %w", err)
		}
	}
}

// prStatusWorkflow is the per-PR lifecycle tracker. It is deterministic: it only
// consumes "state" Signals (fed by the pollers) and records them in its history.
// The Execution completes once the PR is no longer open (merged or closed) — that
// terminal state is the durable record the comment pollers read to stop.
func prStatusWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in PRStatusInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var s PRStateSignal
		w.WaitSignal(SignalPRState, &s)
		if s.State == "merged" || s.State == "closed" {
			return json.Marshal(map[string]any{"pr": in.PR, "state": s.State})
		}
	}
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
	prRunID, err := m.ensurePRStatus(in.PR)
	if err != nil {
		m.logf("task_code_comment: ensure pr_status pr=%d: %v", in.PR, err)
		prRunID = ""
	}
	rootID, err := m.rootID(runID)
	if err != nil {
		return runID, err
	}
	if rootID != 0 {
		go m.poll(ctx, runID, in.PR, rootID, prRunID)
	}
	return runID, nil
}

// Signal delivers a reaction Signal to a running Workflow Execution (the UI
// path: the only way the UI writes anything).
func (m *TaskManager) Signal(runID string, r ReactionSignal) error {
	return m.engine.SignalWorkflow(runID, SignalReply, r)
}

// Heartbeat records that the reviewer is actively viewing thread runID, so the
// poller keeps its fast cadence. It mutates no durable state — only in-memory
// poll timing — so it sits outside the workflow write-boundary.
func (m *TaskManager) Heartbeat(runID string) {
	m.mu.Lock()
	m.lastBeat[runID] = time.Now()
	m.mu.Unlock()
}

// ensurePRStatus returns the Run ID of the pr_status tracker for pr, starting one
// if none is live yet (one tracker per PR, reused across restarts).
func (m *TaskManager) ensurePRStatus(pr int) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.prRuns[pr]; ok {
		return id, nil
	}
	if id := m.findPRStatusLocked(pr); id != "" {
		m.prRuns[pr] = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowPRStatus, PRStatusInput{PR: pr})
	if err != nil {
		return "", err
	}
	m.prRuns[pr] = id
	return id, nil
}

// findPRStatusLocked scans for a running/waiting pr_status tracker for pr. It
// reads only the engine (no TaskManager state), so it is safe to call while
// holding m.mu.
func (m *TaskManager) findPRStatusLocked(pr int) string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowPRStatus {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin PRStatusInput
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr {
			return r.ID
		}
	}
	return ""
}

// EnsureInbox starts (or reuses) the single pr_inbox Execution for the repo,
// fetches an initial snapshot synchronously (so the read-model is populated
// before the server serves), and launches its refresh poller. Idempotent across
// restarts: it reuses an existing running/waiting Execution.
func (m *TaskManager) EnsureInbox(ctx context.Context) {
	m.mu.Lock()
	runID := m.inboxRun
	if runID == "" {
		runID = m.findInboxRunLocked()
	}
	m.mu.Unlock()

	if runID == "" {
		id, err := m.engine.StartWorkflow(WorkflowPRInbox, PRInboxInput{Repo: m.repo})
		if err != nil {
			m.logf("pr_inbox: start: %v", err)
			return
		}
		runID = id
	}
	m.mu.Lock()
	m.inboxRun = runID
	m.mu.Unlock()

	// Initial refresh runs the fetch Activity synchronously, so /api/inbox has a
	// snapshot the moment the server comes up.
	if err := m.engine.SignalWorkflow(runID, SignalRefresh, json.RawMessage("{}")); err != nil {
		m.logf("pr_inbox: initial refresh: %v", err)
	}
	go m.pollInbox(ctx, runID)
}

// InboxRunID returns the pr_inbox Run ID so the UI can signal/heartbeat it.
func (m *TaskManager) InboxRunID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.inboxRun
}

// RefreshInbox delivers a "refresh" Signal (the UI's on-load re-check). It only
// starts a fetch Activity inside the workflow — the sole state writer.
func (m *TaskManager) RefreshInbox(runID string) error {
	return m.engine.SignalWorkflow(runID, SignalRefresh, json.RawMessage("{}"))
}

// findInboxRunLocked scans for a running/waiting pr_inbox Execution for m.repo.
func (m *TaskManager) findInboxRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowPRInbox {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin PRInboxInput
		if json.Unmarshal(in, &pin) == nil && pin.Repo == m.repo {
			return r.ID
		}
	}
	return ""
}

// pollInbox signals a "refresh" on the heartbeat-driven cadence: fast
// (m.interval) while the overview is actively viewed (a heartbeat arrived within
// heartbeatWindow), else slow (m.idle). It never stops on its own — the inbox is
// a long-lived tracker — only when the context is cancelled or the run failed.
func (m *TaskManager) pollInbox(ctx context.Context, runID string) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	var lastPoll time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		m.mu.Lock()
		beat := m.lastBeat[runID]
		m.mu.Unlock()
		active := !beat.IsZero() && time.Since(beat) < heartbeatWindow
		want := m.idle
		if active {
			want = m.interval
		}
		if !lastPoll.IsZero() && time.Since(lastPoll) < want {
			continue
		}
		lastPoll = time.Now()

		status, err := m.engine.Status(runID)
		if err != nil || status == tembed.StatusFailed || status == tembed.StatusCompleted {
			return
		}
		if err := m.engine.SignalWorkflow(runID, SignalRefresh, json.RawMessage("{}")); err != nil {
			m.logf("pr_inbox: refresh signal run=%s: %v", runID, err)
		}
	}
}

// poll delivers each new GitHub reply as a "reply" Signal. Its cadence follows
// the reviewer: fast (m.interval) while a heartbeat arrived within
// heartbeatWindow, else slow (m.idle). On the slow cadence it also checks whether
// the PR is merged/closed, records it on the pr_status tracker, and stops.
func (m *TaskManager) poll(ctx context.Context, runID string, pr int, rootID int64, prRunID string) {
	seen := map[int64]bool{}
	// Wake at the fast cadence and re-evaluate each time, so a heartbeat arriving
	// mid-idle switches to fast promptly instead of after a full idle sleep. The
	// actual GitHub calls are gated to the desired cadence via lastPoll.
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	var lastPoll time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		m.mu.Lock()
		beat := m.lastBeat[runID]
		m.mu.Unlock()
		active := !beat.IsZero() && time.Since(beat) < heartbeatWindow
		want := m.idle
		if active {
			want = m.interval
		}
		if !lastPoll.IsZero() && time.Since(lastPoll) < want {
			continue // not yet time for the current cadence
		}
		lastPoll = time.Now()

		status, err := m.engine.Status(runID)
		if err != nil || status == tembed.StatusCompleted || status == tembed.StatusFailed {
			return
		}
		// Stop once the PR is no longer open — another poller for the same PR may
		// already have recorded merged/closed on the tracker.
		if prRunID != "" {
			if s, err := m.engine.Status(prRunID); err == nil && (s == tembed.StatusCompleted || s == tembed.StatusFailed) {
				return
			}
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

		// Slow cadence only: check whether the PR merged/closed. Record it on the
		// pr_status tracker (best-effort) and stop polling this thread.
		if !active {
			state, err := m.gh.PRState(ctx, pr)
			if err != nil {
				m.logf("task_code_comment: pr state pr=%d: %v", pr, err)
			} else if state != "open" {
				if prRunID != "" {
					if err := m.engine.SignalWorkflow(prRunID, SignalPRState, PRStateSignal{State: state}); err != nil {
						m.logf("task_code_comment: signal pr_status pr=%d: %v", pr, err)
					}
				}
				m.logf("task_code_comment: pr #%d %s — stop polling run=%s", pr, state, runID)
				return
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
