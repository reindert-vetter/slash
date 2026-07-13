package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/callresolve"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/inbox"
	"slash/modules/prmeta"
	"slash/modules/relations"
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
	// WorkflowBuildRelations is the Workflow Type that derives block relations
	// (the call-graph edges): one Execution per PR. It runs a build once on start
	// and again on each "rebuild" Signal (re-ingest). Designed to be extended with
	// more relation detectors later.
	WorkflowBuildRelations = "build_relations"
	// WorkflowResolveCall is the Workflow Type that resolves a changed block's
	// method calls to their definition with an LLM when the Go resolver could not:
	// it runs Haiku first and, if that is not confident, escalates automatically to
	// Sonnet (no signal). One Execution per resolve request; it completes when done.
	WorkflowResolveCall = "resolve_call"
	// SignalReply is the Signal Name a reaction is delivered under.
	SignalReply = "reply"
	// SignalPRState is the Signal Name the poller delivers an observed PR state
	// under to the pr_status tracker.
	SignalPRState = "state"
	// SignalRefresh asks the pr_inbox workflow to re-fetch the inbox now (sent by
	// the UI on page load and by the poller on its cadence).
	SignalRefresh = "refresh"
	// SignalRebuild asks the build_relations workflow to recompute a PR's
	// relations now (sent after a re-ingest).
	SignalRebuild = "rebuild"
	// SignalDelete is the URL-level signal name the UI posts to delete a
	// comment. It is delivered to the workflow as a ReactionSignal (Action:
	// "delete") under SignalReply — see ReactionSignal's doc comment.
	SignalDelete = "delete"

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
	// Code is the source snippet the comment attaches to, with Gran/Label
	// describing it — carried so the thread shows the same code the composer did.
	Code  string `json:"code"`
	Gran  string `json:"gran"`
	Label string `json:"label"`
	// RowStart/RowEnd/Seg pin the comment to its exact navigation unit within the
	// block (aligned-diff row range + call segment) so the comment index can be
	// filtered to the units under the current selection. RowStart < 0 = unknown.
	RowStart int    `json:"rowStart"`
	RowEnd   int    `json:"rowEnd"`
	Seg      string `json:"seg"`
}

// ReactionSignal is the payload of a "reply" Signal. It carries either a
// reaction hooking onto the comment (Action "" / "reply", from the UI or from
// GitHub) or a request to delete the comment (Action "delete") — both ride the
// same Signal because a workflow can only WaitSignal on one name at a time
// (see taskCodeCommentWorkflow's reactions loop), so a delete request has to
// be delivered as a distinguishable reply rather than a signal of its own.
type ReactionSignal struct {
	ID     string `json:"id"`
	Source string `json:"source"` // ui | github
	Author string `json:"author"`
	Body   string `json:"body"`
	Done   bool   `json:"done"`   // resolves the thread
	Action string `json:"action"` // "" (reply, default) | "delete"
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

// BuildRelationsInput starts (and re-signals) a build_relations Execution — one
// per PR.
type BuildRelationsInput struct {
	PR int `json:"pr"`
}

// ResolveCallInput starts a resolve_call Execution: it asks the LLM to resolve
// the given (Go-unresolved) call keys made by one caller block.
type ResolveCallInput struct {
	PR          int      `json:"pr"`
	CallerID    string   `json:"callerId"`
	CallerFile  string   `json:"callerFile"`
	CallerClass string   `json:"callerClass"`
	CallerName  string   `json:"callerName"`
	Calls       []string `json:"calls"`
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
	engine      *tembed.Engine
	gh          github.Client
	comments    *comments.Module
	inbox       *inbox.Module
	relations   *relations.Module
	prmeta      *prmeta.Module
	callresolve *callresolve.Module
	claude      claude.Client
	db          *sql.DB
	dataDir     string
	repo        string
	interval    time.Duration // fast cadence (reviewer active)
	idle        time.Duration // slow cadence + PR-state check (reviewer idle)
	logf        func(string, ...any)

	mu       sync.Mutex           // guards lastBeat + prRuns + relRuns + inboxRun
	lastBeat map[string]time.Time // code-comment/inbox Run ID → last heartbeat
	prRuns   map[int]string       // PR → pr_status Run ID
	relRuns  map[int]string       // PR → build_relations Run ID
	inboxRun string               // pr_inbox Run ID (one per repo/process)
}

// NewTaskManager wires the modules onto engine and registers the workflows.
func NewTaskManager(engine *tembed.Engine, gh github.Client, cs *comments.Module, ib *inbox.Module, rel *relations.Module, pm *prmeta.Module, cr *callresolve.Module, cl claude.Client, db *sql.DB, dataDir, repo string) *TaskManager {
	m := &TaskManager{
		engine: engine, gh: gh, comments: cs, inbox: ib, relations: rel, prmeta: pm, callresolve: cr, claude: cl, db: db, dataDir: dataDir, repo: repo,
		interval: pollInterval, idle: idlePollInterval,
		lastBeat: map[string]time.Time{}, prRuns: map[int]string{}, relRuns: map[int]string{},
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

	// Activity: mark the comment as being deleted (write, workflow-driven). The
	// first step of the delete flow, so the UI can show "Aan het verwijderen"
	// while the actual removal (GitHub + the row itself) is still in flight.
	engine.RegisterActivity("markCommentDeleting", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.SetStatus(ctx, arg.ID, "deleting")
	})

	// Activity: delete the GitHub review comment (best-effort — a failure must
	// not block removing our own record of it).
	engine.RegisterActivity("deleteGithubComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR     int   `json:"pr"`
			RootID int64 `json:"rootId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if err := gh.DeleteComment(ctx, arg.PR, arg.RootID); err != nil {
			m.logf("task_code_comment: github delete skipped: %v", err)
		}
		return nil, nil
	})

	// Activity: the comments module removes the comment (write, workflow-driven)
	// — the final step of the delete flow, cascading its reactions.
	engine.RegisterActivity("deleteComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.Delete(ctx, arg.ID)
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

	// Activity: analyse the PR's blocks into relations and store them (write,
	// workflow-driven). Reads the head worktree; the relations module is the only
	// writer of the relations read-model.
	engine.RegisterActivity("buildRelations", func(ctx context.Context, in []byte) ([]byte, error) {
		var input BuildRelationsInput
		if err := json.Unmarshal(in, &input); err != nil {
			return nil, err
		}
		blocks, err := blocksByPR(m.db, input.PR)
		if err != nil {
			return nil, fmt.Errorf("build_relations: load blocks: %w", err)
		}
		rels := buildRelations(m.dataDir, input.PR, blocks)
		if err := m.relations.Replace(ctx, input.PR, rels); err != nil {
			return nil, fmt.Errorf("build_relations: save: %w", err)
		}
		// Also resolve method calls statically (resolved/unresolved) into the
		// callresolve read-model. UpsertGo preserves LLM-owned rows.
		calls := resolveCalls(m.dataDir, input.PR, blocks)
		if m.callresolve != nil {
			if err := m.callresolve.UpsertGo(ctx, calls); err != nil {
				return nil, fmt.Errorf("build_relations: save calls: %w", err)
			}
			// Drop stale rows: every (caller, call) pair the scan no longer emits —
			// the caller block left the PR, or the call site is no longer on a
			// changed line.
			if err := m.callresolve.Prune(ctx, input.PR, calls); err != nil {
				return nil, fmt.Errorf("build_relations: prune calls: %w", err)
			}
		}
		return json.Marshal(map[string]int{"relations": len(rels), "calls": len(calls)})
	})

	// Activity: mark a caller's calls as being searched (write, workflow-driven).
	engine.RegisterActivity("markCallsSearching", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ResolveCallInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.callresolve == nil {
			return nil, nil
		}
		return nil, m.callresolve.SaveSearching(ctx, arg.PR, arg.CallerID, arg.Calls)
	})

	// Activity: resolve calls with one LLM model (Haiku = context-only shortlist,
	// Sonnet = agentic worktree search). Reads the head worktree + shells out to
	// the claude CLI — a side effect, hence an Activity. Returns one entry per call
	// (found/notfound, verified against the worktree).
	engine.RegisterActivity("resolveWithModel", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg resolveArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		entries := resolveCallsWithModel(ctx, m.claude, m.dataDir, arg)
		return json.Marshal(entries)
	})

	// Activity: persist the final LLM resolutions (write, workflow-driven).
	engine.RegisterActivity("saveResolutions", func(ctx context.Context, in []byte) ([]byte, error) {
		var entries []callresolve.Entry
		if err := json.Unmarshal(in, &entries); err != nil {
			return nil, err
		}
		if m.callresolve == nil {
			return nil, nil
		}
		for _, e := range entries {
			if err := m.callresolve.Save(ctx, e); err != nil {
				return nil, err
			}
		}
		return json.Marshal(map[string]int{"saved": len(entries)})
	})

	// Activity: fetch the PR's metadata (title + URL) from GitHub and store it in
	// the prmeta read-model (write, workflow-driven). Best-effort: a GitHub hiccup
	// or a nil store (tests) must not sink the pr_status tracker.
	engine.RegisterActivity("fetchPRMeta", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PRStatusInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prmeta == nil {
			return nil, nil
		}
		meta, err := gh.PRMeta(ctx, arg.PR)
		if err != nil {
			m.logf("pr_status: fetch meta pr=%d skipped: %v", arg.PR, err)
			return nil, nil
		}
		if err := m.prmeta.Save(ctx, prmeta.Meta{PR: arg.PR, Title: meta.Title, URL: meta.URL}); err != nil {
			return nil, fmt.Errorf("save pr meta: %w", err)
		}
		return nil, nil
	})

	engine.RegisterWorkflow(WorkflowTaskCodeComment, taskCodeCommentWorkflow)
	engine.RegisterWorkflow(WorkflowPRStatus, prStatusWorkflow)
	engine.RegisterWorkflow(WorkflowPRInbox, prInboxWorkflow)
	engine.RegisterWorkflow(WorkflowBuildRelations, buildRelationsWorkflow)
	engine.RegisterWorkflow(WorkflowResolveCall, resolveCallWorkflow)
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

// buildRelationsWorkflow derives a PR's block relations. It is deterministic:
// the build (which reads the worktree + writes the read-model) is an Activity.
// It builds once on start, then rebuilds on each "rebuild" Signal (re-ingest),
// so it stays a long-lived per-PR tracker we can extend with more detectors.
func buildRelationsWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in BuildRelationsInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("buildRelations", in, nil); err != nil {
		return nil, fmt.Errorf("build relations: %w", err)
	}
	for {
		var s json.RawMessage
		w.WaitSignal(SignalRebuild, &s)
		if err := w.ExecuteActivity("buildRelations", in, nil); err != nil {
			return nil, fmt.Errorf("rebuild relations: %w", err)
		}
	}
}

// resolveCallWorkflow resolves a caller's Go-unresolved method calls with the
// LLM. It is deterministic: the LLM/worktree work is in Activities, and the
// escalation decision reads the recorded Haiku result (history), not live model
// output. It runs Haiku first, escalates the still-unfound calls to Sonnet
// automatically (no signal), then persists the merged result and completes.
func resolveCallWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ResolveCallInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if len(in.Calls) == 0 {
		return json.Marshal(map[string]int{"found": 0})
	}
	if err := w.ExecuteActivity("markCallsSearching", in, nil); err != nil {
		return nil, fmt.Errorf("mark searching: %w", err)
	}

	// Haiku first (context-only shortlist).
	var haiku []callresolve.Entry
	if err := w.ExecuteActivity("resolveWithModel", resolveArg{
		PR: in.PR, CallerID: in.CallerID, CallerFile: in.CallerFile,
		CallerClass: in.CallerClass, CallerName: in.CallerName,
		Calls: in.Calls, Model: claude.ModelHaiku,
	}, &haiku); err != nil {
		return nil, fmt.Errorf("resolve haiku: %w", err)
	}

	// Escalate the calls Haiku did not confidently find to Sonnet (agentic).
	byKey := map[string]callresolve.Entry{}
	var escalate []string
	for _, e := range haiku {
		byKey[e.CallKey] = e
		if e.Status != callresolve.StatusFound {
			escalate = append(escalate, e.CallKey)
		}
	}
	if len(escalate) > 0 {
		var sonnet []callresolve.Entry
		if err := w.ExecuteActivity("resolveWithModel", resolveArg{
			PR: in.PR, CallerID: in.CallerID, CallerFile: in.CallerFile,
			CallerClass: in.CallerClass, CallerName: in.CallerName,
			Calls: escalate, Model: claude.ModelSonnet,
		}, &sonnet); err != nil {
			return nil, fmt.Errorf("resolve sonnet: %w", err)
		}
		for _, e := range sonnet {
			byKey[e.CallKey] = e // the Sonnet result wins over Haiku
		}
	}

	// Persist the merged result in the deterministic order of in.Calls.
	final := make([]callresolve.Entry, 0, len(in.Calls))
	found := 0
	for _, c := range in.Calls {
		if e, ok := byKey[c]; ok {
			final = append(final, e)
			if e.Status == callresolve.StatusFound {
				found++
			}
		}
	}
	if err := w.ExecuteActivity("saveResolutions", final, nil); err != nil {
		return nil, fmt.Errorf("save resolutions: %w", err)
	}
	return json.Marshal(map[string]int{"found": found})
}

// StartResolveCall launches a resolve_call Execution and returns its Run ID.
// Starting an Execution is the sanctioned UI write path.
func (m *TaskManager) StartResolveCall(in ResolveCallInput) (string, error) {
	return m.engine.StartWorkflow(WorkflowResolveCall, in)
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
	// Fetch the PR's metadata (title + URL) once at start (synchronously, inside
	// StartWorkflow), so the read-model is filled before the tracker parks on the
	// first state Signal. The UI reads it via GET /api/pr for the `/` menu.
	if err := w.ExecuteActivity("fetchPRMeta", in, nil); err != nil {
		return nil, fmt.Errorf("fetch pr meta: %w", err)
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
// commentPath builds the hierarchical address a comment hangs on, from the PR
// down to the exact code reference:
//
//	/pr-<pr>/<file>/<label>/<codeRef>/comment-<id>
//
// The file keeps its slashes, so it forms natural sub-segments (a directory
// prefix matches too). A prefix search then narrows by scope: "/pr-123" is the
// whole PR, "/pr-123/app/Foo.php" one file, ".../Foo::bar" one block, and
// ".../group-5-9" one navigation unit. Pure function of the input + Run ID, so
// it's deterministic under workflow replay.
func commentPath(in CodeCommentInput, id string) string {
	parts := []string{fmt.Sprintf("pr-%d", in.PR)}
	if in.File != "" {
		parts = append(parts, in.File) // already a validated repo-relative path
	}
	if in.Label != "" {
		parts = append(parts, pathSeg(in.Label))
	}
	if ref := codeRef(in); ref != "" {
		parts = append(parts, ref)
	}
	parts = append(parts, "comment-"+id)
	return "/" + strings.Join(parts, "/")
}

// codeRef names the navigation unit segment of a comment path: the granularity
// plus its row anchor (and, for a call, its segment key). Empty when the anchor
// is unknown and there's no granularity to fall back on.
func codeRef(in CodeCommentInput) string {
	if in.RowStart < 0 {
		return in.Gran // block-level / unknown rows: just the granularity (or "")
	}
	switch in.Gran {
	case "line":
		return fmt.Sprintf("line-%d", in.RowStart)
	case "call":
		if in.Seg != "" {
			return fmt.Sprintf("call-%d-%s", in.RowStart, pathSeg(in.Seg))
		}
		return fmt.Sprintf("call-%d", in.RowStart)
	default: // group (the default granularity)
		return fmt.Sprintf("group-%d-%d", in.RowStart, in.RowEnd)
	}
}

// pathSeg makes a single path segment safe: it keeps letters, digits and the
// harmless punctuation a symbol/segment key uses (`. _ - :`) and turns anything
// else (spaces, slashes, …) into `-`, so a segment can't inject an extra `/`.
func pathSeg(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-', r == ':':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

func taskCodeCommentWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in CodeCommentInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	runID := w.RunID()

	// Store the comment (comments module) and post it (github module). The
	// hierarchical Path is built here (deterministic from input + Run ID) so it
	// lands in the read-model via the workflow, not from the UI.
	comment := comments.Comment{
		ID: runID, RunID: runID, PR: in.PR, File: in.File, Line: in.Line,
		Author: in.Author, Body: in.Body,
		Code: in.Code, Gran: in.Gran, Label: in.Label,
		RowStart: in.RowStart, RowEnd: in.RowEnd, Seg: in.Seg,
		Path: commentPath(in, runID),
	}
	if err := w.ExecuteActivity("saveComment", comment, nil); err != nil {
		return nil, fmt.Errorf("save comment: %w", err)
	}
	var posted postResult
	if err := w.ExecuteActivity("postGithubComment", in, &posted); err != nil {
		return nil, fmt.Errorf("post github comment: %w", err)
	}

	// Reactions loop: each "reply" Signal (UI or GitHub) is stored, mirrored to
	// the other side, and closes the thread when Done. A "delete" Action instead
	// removes the comment — first flipping its status to "deleting", then
	// deleting it on GitHub (best-effort) and from our own store — and completes
	// the execution, ending the thread.
	reactions := 0
	for {
		var r ReactionSignal
		w.WaitSignal(SignalReply, &r)

		if r.Action == "delete" {
			if err := w.ExecuteActivity("markCommentDeleting", map[string]any{"id": runID}, nil); err != nil {
				return nil, fmt.Errorf("mark comment deleting: %w", err)
			}
			if err := w.ExecuteActivity("deleteGithubComment", map[string]any{
				"pr": in.PR, "rootId": posted.RootID,
			}, nil); err != nil {
				return nil, fmt.Errorf("delete github comment: %w", err)
			}
			if err := w.ExecuteActivity("deleteComment", map[string]any{"id": runID}, nil); err != nil {
				return nil, fmt.Errorf("delete comment: %w", err)
			}
			return json.Marshal(map[string]any{"comment": runID, "deleted": true})
		}

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

// EnsurePRStatus ensures a pr_status tracker exists for pr (starting one, whose
// start synchronously fetches the PR's metadata into the prmeta read-model) and
// returns its Run ID. The UI calls this on page load so the `/` menu's
// Jira/GitHub links have the PR title. Starting/reusing an Execution is the
// sanctioned UI write path.
func (m *TaskManager) EnsurePRStatus(pr int) (string, error) {
	return m.ensurePRStatus(pr)
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

// EnsureRelations makes sure a build_relations Execution exists for pr and has
// (re)built its relations. It starts one if none is live (the initial build runs
// synchronously inside StartWorkflow); otherwise it signals a rebuild. One
// Execution per PR, reused across restarts. Called after a successful ingest.
func (m *TaskManager) EnsureRelations(ctx context.Context, pr int) {
	m.mu.Lock()
	runID := m.relRuns[pr]
	if runID == "" {
		runID = m.findBuildRelationsLocked(pr)
	}
	m.mu.Unlock()

	if runID == "" {
		id, err := m.engine.StartWorkflow(WorkflowBuildRelations, BuildRelationsInput{PR: pr})
		if err != nil {
			m.logf("build_relations: start pr=%d: %v", pr, err)
			return
		}
		m.mu.Lock()
		m.relRuns[pr] = id
		m.mu.Unlock()
		return
	}
	m.mu.Lock()
	m.relRuns[pr] = runID
	m.mu.Unlock()
	if err := m.engine.SignalWorkflow(runID, SignalRebuild, json.RawMessage("{}")); err != nil {
		m.logf("build_relations: rebuild signal pr=%d: %v", pr, err)
	}
}

// findBuildRelationsLocked scans for a running/waiting build_relations Execution
// for pr. Reads only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findBuildRelationsLocked(pr int) string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowBuildRelations {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin BuildRelationsInput
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
