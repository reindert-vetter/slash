package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/jira"
	"slash/modules/jiranotify"
)

// This file holds the `jira_inbox` tracker: the reviewer's own Jira
// notification feed (the bell menu) as a list on /pr-overview. Same split as
// ingest.go/cleanup.go — the workflow body, its Activities and the manager glue
// live here; only the Register* lines sit in workflows.go, next to the other
// trackers.
//
// Shape: ONE long-lived Execution for the whole process (the feed is per-USER,
// not per-repo — unlike pr_inbox), waiting on a single Signal in a loop. Two
// things travel through that one Signal, distinguished by its payload's `kind`:
//
//	{"kind":"refresh"}          — the 5-minute poller and the UI on load
//	{"kind":"read","id":"…"}    — the reviewer opened a notification here
//
// One Signal name rather than two because tembed's WaitSignal takes exactly one
// name; branching on a payload that comes straight out of the recorded history
// stays deterministic (see .claude/rules/workflow-determinism.md).
//
// Why not fold this into the existing comment/task workflows, as asked: those
// are per-PR, per-comment task state driven by the review tree
// (task_code_comment / comment_import), keyed by (repo, pr, comment) and
// started from a reviewer action on a block. A Jira notification has no PR at
// all and no task to work through — it is a polled, user-wide feed, which is
// exactly the mould pr_inbox already provides. So this mirrors pr_inbox and
// keeps the comment workflows untouched.

// jiraNotifyLimit is how many feed entries one refresh pulls. The bell menu
// itself shows a comparable window; more would only grow the read model with
// rows the retention below deletes anyway.
const jiraNotifyLimit = 30

// jiraNotifyInterval is the poll cadence (Reindert: "elke 5 minuten"). Fixed
// rather than heartbeat-driven like pollInbox: this feed is not what the
// reviewer is staring at while triaging, and every tick is a real HTTP call to
// Atlassian.
const jiraNotifyInterval = 5 * time.Minute

// jiraNotifyRetention is how long a notification is kept before the cleanup
// pass deletes it — Reindert: "verwijder notifications uit server na maximaal
// 30 dagen".
const jiraNotifyRetention = 30 * 24 * time.Hour

// JiraNotifyInput starts the single jira_inbox Execution.
type JiraNotifyInput struct{}

// JiraNotifySignal is the one Signal payload the tracker reacts to. Kind is
// "refresh" (default, also for an empty payload) or "read".
type JiraNotifySignal struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// jiraNotifyResult is the small summary the refresh Activity returns, so the
// endlessly-refreshing history stays compact. A FETCH FAILURE is reported in
// here rather than returned as an error: an unconfigured token or a changed
// (undocumented) endpoint must not fail the tracker permanently — it would then
// never poll again until a restart.
type jiraNotifyResult struct {
	Configured bool   `json:"configured"`
	Stored     int    `json:"stored"`
	Error      string `json:"error,omitempty"`
}

// jiraNotifyStatus is the last refresh outcome, kept in memory only so the
// read-only endpoint can say "no token configured" / "the feed call failed"
// instead of silently showing an empty list. Purely operational — nothing
// durable, gone after a restart, the same carve-out as the ingest-progress map
// (see .claude/rules/workflows-write-boundary.md).
type jiraNotifyStatus struct {
	Configured bool
	Error      string
	At         time.Time
}

// jiraInboxWorkflow owns the Jira notification feed. Deterministic: one Signal
// per loop iteration, and the branch below reads only that Signal's recorded
// payload. It never completes — a long-lived tracker.
func jiraInboxWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	for {
		var sig JiraNotifySignal
		w.WaitSignal(SignalJiraNotify, &sig)
		if sig.Kind == "read" {
			if err := w.ExecuteActivity("markJiraNotificationRead", sig, nil); err != nil {
				return nil, fmt.Errorf("mark jira notification read: %w", err)
			}
			continue
		}
		var res jiraNotifyResult
		if err := w.ExecuteActivity("refreshJiraNotifications", JiraNotifyInput{}, &res); err != nil {
			return nil, fmt.Errorf("refresh jira notifications: %w", err)
		}
	}
}

// registerJiraNotifyActivities wires the two Activities. Called from
// registerWorkflows in workflows.go.
func (m *TaskManager) registerJiraNotifyActivities(engine *tembed.Engine) {
	// The jiranotify module is the only writer of this read-model.
	engine.RegisterActivity("refreshJiraNotifications", func(ctx context.Context, in []byte) ([]byte, error) {
		return json.Marshal(m.refreshJiraNotifications(ctx))
	})
	engine.RegisterActivity("markJiraNotificationRead", func(ctx context.Context, in []byte) ([]byte, error) {
		var sig JiraNotifySignal
		if err := json.Unmarshal(in, &sig); err != nil {
			return nil, err
		}
		if m.jiranotify == nil || sig.ID == "" {
			return nil, nil
		}
		return nil, m.jiranotify.MarkRead(ctx, sig.ID, time.Now().UTC().Format(time.RFC3339))
	})
}

// refreshJiraNotifications fetches the feed and upserts it into the read-model.
// It never returns an error (see jiraNotifyResult): a missing token or a failing
// call is recorded on the result and in m.jiraStatus.
func (m *TaskManager) refreshJiraNotifications(ctx context.Context) jiraNotifyResult {
	res := jiraNotifyResult{Configured: true}
	if m.jira == nil || m.jiranotify == nil {
		res.Configured = false
		m.setJiraStatus(res)
		return res
	}
	list, err := m.jira.Notifications(ctx, jiraNotifyLimit)
	if errors.Is(err, jira.ErrNotConfigured) {
		res.Configured = false
		m.setJiraStatus(res)
		return res
	}
	if err != nil {
		res.Error = err.Error()
		m.setJiraStatus(res)
		return res
	}
	items := make([]jiranotify.Item, 0, len(list))
	for _, n := range list {
		items = append(items, jiranotify.Item{
			ID: n.ID, At: n.At, Title: n.Title, IssueKey: n.IssueKey,
			Actor: n.Actor, AvatarURL: n.AvatarURL, URL: n.URL, Unread: n.Unread,
		})
	}
	if err := m.jiranotify.Upsert(ctx, items); err != nil {
		res.Error = err.Error()
		m.setJiraStatus(res)
		return res
	}
	res.Stored = len(items)
	m.setJiraStatus(res)
	return res
}

func (m *TaskManager) setJiraStatus(res jiraNotifyResult) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.jiraStatus = jiraNotifyStatus{Configured: res.Configured, Error: res.Error, At: time.Now()}
}

// JiraNotifyStatus reports the last refresh outcome — read-only, backs the
// "configured"/"error" fields of GET /api/jira/notifications.
func (m *TaskManager) JiraNotifyStatus() jiraNotifyStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jiraStatus
}

// ListJiraNotifications returns the stored feed, newest first. READ-only.
func (m *TaskManager) ListJiraNotifications(ctx context.Context, limit int) ([]jiranotify.Item, error) {
	if m.jiranotify == nil {
		return nil, nil
	}
	return m.jiranotify.List(ctx, limit)
}

// EnsureJiraInbox starts (or reuses) the single jira_inbox Execution and, once
// the ready gate opens, runs an initial refresh and starts the poller. Mirrors
// EnsureInbox; idempotent across restarts.
func (m *TaskManager) EnsureJiraInbox(ctx context.Context) string {
	m.mu.Lock()
	runID := m.jiraRun
	if runID == "" {
		runID = m.findJiraRunLocked()
	}
	m.mu.Unlock()

	if runID == "" {
		id, err := m.engine.StartWorkflow(WorkflowJiraInbox, JiraNotifyInput{})
		if err != nil {
			m.logf("jira_inbox: start: %v", err)
			return ""
		}
		runID = id
	}
	m.mu.Lock()
	m.jiraRun = runID
	m.mu.Unlock()
	return runID
}

// StartJiraInboxPolling runs the initial refresh and the 5-minute poller behind
// the ready gate. Split from EnsureJiraInbox so a handler can ensure the run
// (and get its Run ID to signal a "read" to) without ever spawning a poller.
func (m *TaskManager) StartJiraInboxPolling(ctx context.Context) {
	runID := m.EnsureJiraInbox(ctx)
	if runID == "" {
		return
	}
	go func() {
		m.waitReady()
		m.signalJiraNotify(runID, JiraNotifySignal{Kind: "refresh"})
		m.pollJiraNotifications(ctx, runID)
	}()
}

// pollJiraNotifications signals a refresh every jiraNotifyInterval. It never
// stops on its own — only when the context is cancelled or the run is gone.
func (m *TaskManager) pollJiraNotifications(ctx context.Context, runID string) {
	ticker := time.NewTicker(jiraNotifyInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		status, err := m.engine.Status(runID)
		if err != nil || status == tembed.StatusFailed || status == tembed.StatusCompleted {
			return
		}
		m.signalJiraNotify(runID, JiraNotifySignal{Kind: "refresh"})
	}
}

// signalJiraNotify delivers one Signal, logging (never returning) a failure —
// the poller must survive a bad tick.
func (m *TaskManager) signalJiraNotify(runID string, sig JiraNotifySignal) {
	payload, err := json.Marshal(sig)
	if err != nil {
		m.logf("jira_inbox: marshal signal: %v", err)
		return
	}
	if err := m.engine.SignalWorkflow(runID, SignalJiraNotify, json.RawMessage(payload)); err != nil {
		m.logf("jira_inbox: signal %s run=%s: %v", sig.Kind, runID, err)
	}
}

// JiraInboxRunID returns the tracker's Run ID so the UI can signal a "read" to
// it (the sanctioned write path).
func (m *TaskManager) JiraInboxRunID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jiraRun
}

// findJiraRunLocked scans for a running/waiting jira_inbox Execution.
func (m *TaskManager) findJiraRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowJiraInbox {
			continue
		}
		if r.Status == tembed.StatusRunning || r.Status == tembed.StatusWaiting {
			return r.ID
		}
	}
	return ""
}
