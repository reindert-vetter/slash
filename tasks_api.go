package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/callresolve"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/explanations"
	"slash/modules/github"
	"slash/modules/inbox"
	"slash/modules/jira"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/testcovers"
)

// tasks holds the workflow engine + the module read sides. It is built once at
// server start.
type tasks struct {
	engine      *tembed.Engine
	manager     *TaskManager
	comments    *comments.Module
	inbox       *inbox.Module
	relations   *relations.Module
	prmeta      *prmeta.Module
	callresolve *callresolve.Module
	testcovers  *testcovers.Module
	approvals   *approvals.Module
	explain     *explanations.Module
}

// newTasks builds the tembed engine (SQLite + JSONL, so comments live in the
// workflow event history AND in jsonl files), the comments module, and the
// github module, then recovers in-flight executions and resumes their pollers.
// resumeRuntime gates the server-only runtime bits (resuming comment pollers,
// ensuring the inbox tracker + its poller) — a one-shot CLI caller (e.g. `slash
// ingest`) passes false so it doesn't start background pollers or fetch the
// inbox just to run a single workflow.
func newTasks(ctx context.Context, db *sql.DB, dataDir, repo string, resumeRuntime bool) (*tasks, func() error, error) {
	sq, err := tembed.NewSQLiteStore(dataDir + "/workflows.db")
	if err != nil {
		return nil, nil, err
	}
	jl, err := tembed.NewJSONLStore(dataDir + "/workflows")
	if err != nil {
		sq.Close()
		return nil, nil, err
	}
	engine := tembed.New(tembed.NewMultiStore(sq, jl))

	cs, err := comments.Open(dataDir + "/comments.db")
	if err != nil {
		sq.Close()
		return nil, nil, err
	}
	ib, err := inbox.Open(dataDir + "/inbox.db")
	if err != nil {
		sq.Close()
		cs.Close()
		return nil, nil, err
	}
	rel, err := relations.Open(dataDir + "/relations.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		return nil, nil, err
	}
	pm, err := prmeta.Open(dataDir + "/prmeta.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		return nil, nil, err
	}
	cr, err := callresolve.Open(dataDir + "/callresolve.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		return nil, nil, err
	}
	tc, err := testcovers.Open(dataDir + "/testcovers.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		return nil, nil, err
	}
	ap, err := approvals.Open(dataDir + "/approvals.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		return nil, nil, err
	}
	ex, err := explanations.Open(dataDir + "/explanations.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		return nil, nil, err
	}

	// Under test (SLASH_GITHUB=off) use a no-network Fake so runs never touch a
	// real repo; otherwise talk to GitHub via gh.
	var gh github.Client = github.New(repo)
	if os.Getenv("SLASH_GITHUB") == "off" {
		gh = &github.Fake{}
	}
	// Under SLASH_CLAUDE=off the LLM resolver never shells out — an empty Fake
	// resolves nothing (offline/tests). Otherwise use the real claude CLI, with
	// a scratch cwd reserved for its context-only runs — see modules/claude's
	// Module.scratchDir doc. Deliberately anchored under os.TempDir(), NOT
	// under dataDir: `claude` walks *up* the directory tree from its cwd
	// looking for a CLAUDE.md (like git looks for .git), so anything nested
	// inside this repo (dataDir is normally "data/" under the repo root)
	// would still find and load this project's own CLAUDE.md/.claude/rules —
	// confirmed empirically, see the resolve_call section of
	// .claude/rules/tembed-workflows.md.
	var cl claude.Client = claude.New(filepath.Join(os.TempDir(), "slash-llm-cwd"))
	if os.Getenv("SLASH_CLAUDE") == "off" {
		cl = claude.NewFake()
	}
	// Under SLASH_JIRA=off the Jira bridge never shells out (offline/tests): an
	// empty Fake reports no linked issue for every key.
	var jr jira.Client = jira.New()
	if os.Getenv("SLASH_JIRA") == "off" {
		jr = &jira.Fake{}
	}
	mgr := NewTaskManager(engine, gh, cs, ib, rel, pm, cr, tc, ap, ex, cl, jr, db, dataDir, repo)
	// Record the server-lifetime context + whether background pollers may run,
	// so ensurePRStatus's fresh-poller spawn uses a context that outlives the
	// HTTP request that triggered it (see TaskManager.baseCtx).
	mgr.SetRuntime(ctx, resumeRuntime)

	if err := engine.Recover(); err != nil {
		return nil, nil, err
	}
	if resumeRuntime {
		mgr.ResumePolling(ctx)
		// Resume the ingest-refresh poller for every pr_status tracker that was
		// already running before this restart (mirrors ResumePolling).
		mgr.ResumePRStatusPolling(ctx)
		// Own the PR inbox via the workflow: fetch an initial snapshot into the
		// read-model and start the refresh poller (the UI reads only the read-model).
		mgr.EnsureInbox(ctx)
	}

	closeFn := func() error {
		_ = sq.Close()
		_ = ib.Close()
		_ = rel.Close()
		_ = pm.Close()
		_ = cr.Close()
		_ = tc.Close()
		_ = ap.Close()
		_ = ex.Close()
		return cs.Close()
	}
	return &tasks{engine: engine, manager: mgr, comments: cs, inbox: ib, relations: rel, prmeta: pm, callresolve: cr, testcovers: tc, approvals: ap, explain: ex}, closeFn, nil
}

// ResumePolling restarts the GitHub poller for every waiting code-comment
// execution after a restart (so the "check GitHub every minute" keeps running).
func (m *TaskManager) ResumePolling(ctx context.Context) {
	runs, err := m.engine.Runs()
	if err != nil {
		m.logf("task_code_comment: resume polling: %v", err)
		return
	}
	for _, r := range runs {
		if r.Workflow != WorkflowTaskCodeComment || r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input CodeCommentInput
		if json.Unmarshal(in, &input) != nil {
			continue
		}
		// An imported thread's root ID lives in its input, not in a
		// postGithubComment history event (it was never posted), so prefer that.
		rootID := input.ImportedRootID
		if rootID == 0 {
			rootID, _ = m.rootID(r.ID)
		}
		if rootID != 0 {
			prRunID, err := m.ensurePRStatus(input.PR)
			if err != nil {
				m.logf("task_code_comment: resume ensure pr_status pr=%d: %v", input.PR, err)
				prRunID = ""
			}
			// Mark imported threads as polled so a concurrent importPRComments
			// tick doesn't start a second poller for the same run.
			if input.ImportedRootID != 0 {
				m.mu.Lock()
				m.importPolled[r.ID] = true
				m.mu.Unlock()
			}
			go m.poll(ctx, r.ID, input.PR, rootID, prRunID)
		}
	}
}

// ResumePRStatusPolling restarts the ingest-refresh poller for every waiting
// pr_status execution after a restart (mirrors ResumePolling for comment
// threads), so the "check the PR's head SHA" poll keeps running across a
// server restart.
func (m *TaskManager) ResumePRStatusPolling(ctx context.Context) {
	runs, err := m.engine.Runs()
	if err != nil {
		m.logf("pr_status: resume polling: %v", err)
		return
	}
	for _, r := range runs {
		if r.Workflow != WorkflowPRStatus || r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input PRStatusInput
		if json.Unmarshal(in, &input) != nil || input.PR == 0 {
			continue
		}
		m.mu.Lock()
		m.prRuns[input.PR] = r.ID
		m.mu.Unlock()
		go m.pollIngestRefresh(ctx, r.ID, input.PR)
		// Resume importing/polling this PR's GitHub comments too (mirrors the
		// fresh-tracker spawn in ensurePRStatus).
		go m.pollImportComments(ctx, r.ID, input.PR)
	}
}

// WorkflowRunView is one row of the read-only "Taken" (tasks) list: a workflow
// run scoped to a single PR, with a JSON-friendly shape (camelCase, string
// status/time).
type WorkflowRunView struct {
	RunID     string      `json:"runId"`
	Workflow  string      `json:"workflow"`
	Status    string      `json:"status"`
	CreatedAt time.Time   `json:"createdAt"`
	UpdatedAt time.Time   `json:"updatedAt"`
	Comment   *CommentRef `json:"comment,omitempty"`
	// WarningsFound is the number of findings a completed code_warning run
	// produced (from its own recorded Result — see codeWarningWorkflow), so
	// the "Taken" column can say "geen risico's gevonden" instead of a
	// generic status word. nil for every other run, and for a code_warning
	// run that hasn't completed yet.
	WarningsFound *int `json:"warningsFound,omitempty"`
}

// CommentRef is the nested code-comment reference on a task_code_comment run's
// WorkflowRunView row — parsed from the run's own (immutable) input — so the
// "Taken" column can describe what the comment is about and the UI can select
// + scroll to it. RunID (== the comment's id) already sits on the outer view.
type CommentRef struct {
	File     string `json:"file"`
	Label    string `json:"label"`
	Gran     string `json:"gran"`
	Line     int    `json:"line"`
	RowStart int    `json:"rowStart"`
	RowEnd   int    `json:"rowEnd"`
	Snippet  string `json:"snippet"`
}

// commentSnippet trims body to roughly n characters on a word boundary, adding
// an ellipsis when it truncated — a short preview for the "Taken" row.
func commentSnippet(body string, n int) string {
	body = strings.TrimSpace(body)
	if len(body) <= n {
		return body
	}
	cut := body[:n]
	if i := strings.LastIndexAny(cut, " \t\n"); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut) + "…"
}

// RunsForPR lists every workflow run whose input carries the given PR number,
// newest-updated first. Read-only: it only inspects engine.Runs()/Input(), it
// never signals or starts anything. pr_inbox runs are per-repo (no "pr" field
// in their input) so they never match and are correctly excluded.
func (m *TaskManager) RunsForPR(pr int) []WorkflowRunView {
	runs, err := m.engine.Runs()
	if err != nil {
		return nil
	}
	out := make([]WorkflowRunView, 0, len(runs))
	for _, r := range runs {
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input struct {
			PR int `json:"pr"`
		}
		if json.Unmarshal(in, &input) != nil || input.PR != pr {
			continue
		}
		view := WorkflowRunView{
			RunID: r.ID, Workflow: r.Workflow, Status: r.Status,
			CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		}
		if r.Workflow == WorkflowTaskCodeComment {
			var cc CodeCommentInput
			if json.Unmarshal(in, &cc) == nil && cc.File != "" {
				view.Comment = &CommentRef{
					File: cc.File, Label: cc.Label, Gran: cc.Gran, Line: cc.Line,
					RowStart: cc.RowStart, RowEnd: cc.RowEnd,
					Snippet: commentSnippet(cc.Body, 60),
				}
			}
		}
		if r.Workflow == WorkflowCodeWarning && r.Status == tembed.StatusCompleted {
			var res struct {
				Found int `json:"found"`
			}
			if m.engine.Result(r.ID, &res) == nil {
				n := res.Found
				view.WarningsFound = &n
			}
		}
		out = append(out, view)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out
}

// routesTasks registers the workflow + comments routes on mux. Writes go only
// through workflow endpoints (start / signal); everything else is read-only.
func (s *server) routesTasks(mux *http.ServeMux) {
	// POST /api/workflows/task_code_comment            → start an execution
	// GET  /api/workflows/task_code_comment            → list executions
	// POST /api/workflows/{runID}/signals/{signalName} → signal (UI reaction)
	// GET  /api/workflows/{runID}                       → execution status
	mux.HandleFunc("/api/workflows/", s.handleWorkflows)
	mux.HandleFunc("/api/workflows/task_code_comment", s.handleTaskCodeComment)
	// GET /api/workflows?pr=N → read-only list of workflow runs for one PR (the
	// "Taken" column in RelatedPanel): status per run, newest first.
	mux.HandleFunc("/api/workflows", s.handleWorkflowsList)
	// POST /api/workflows/resolve_call → start an LLM call-resolution execution
	mux.HandleFunc("/api/workflows/resolve_call", s.handleResolveCall)
	// POST /api/workflows/resolve_test_covers → start an LLM test-coverage
	// resolution execution (class-level-only annotations only).
	mux.HandleFunc("/api/workflows/resolve_test_covers", s.handleResolveTestCovers)
	// POST /api/workflows/explain_code → start (idempotently, via a
	// deterministic Run ID) an AI-explanation execution for one navigation unit
	// containing an if-statement (the footer description).
	mux.HandleFunc("/api/workflows/explain_code", s.handleExplainCode)
	// POST /api/workflows/pr_status {pr} → ensure the per-PR lifecycle tracker
	// (its start fetches the PR's metadata into the prmeta read-model).
	mux.HandleFunc("/api/workflows/pr_status", s.handlePRStatusStart)
	// POST /api/workflows/approve {pr} → ensure the per-PR approval tracker; the
	// UI then signals approvals to its Run ID via .../signals/set.
	mux.HandleFunc("/api/workflows/approve", s.handleApproveStart)
	// POST /api/workflows/submit_review {pr,event,body?} → submit a real GitHub
	// PR-level review (approve or request changes). One Execution per submit.
	mux.HandleFunc("/api/workflows/submit_review", s.handleSubmitReview)
	// POST /api/workflows/code_warning {pr} → start an agentic Sonnet review of
	// the whole PR for risks (the "/" menu's "Controleer de hele PR op
	// risico's"). One Execution per manual run.
	mux.HandleFunc("/api/workflows/code_warning", s.handleCodeWarning)
	// GET /api/approvals?pr=N → read-only approval read-model (per block: the
	// approved changed rows + call segments) for refresh-restore.
	mux.HandleFunc("/api/approvals", s.handleApprovals)
	// GET /api/pr?pr=N → read-only PR metadata (title + URL) from the prmeta
	// read-model — for the `/` command menu's Jira/GitHub deep-links.
	mux.HandleFunc("/api/pr", s.handlePR)
	// GET /api/comments?pr=N → read-only comments + reactions for the UI
	mux.HandleFunc("/api/comments", s.handleComments)
	// GET /api/relations?pr=N → read-only block relations (edges) for the UI
	mux.HandleFunc("/api/relations", s.handleRelations)
	// GET /api/callresolve?pr=N → read-only call-resolution read-model (Go +
	// LLM-resolved definitions, and the unresolved calls behind the "Zoek" button)
	mux.HandleFunc("/api/callresolve", s.handleCallResolve)
	// GET /api/testcovers?pr=N → read-only test-coverage read-model (test →
	// covered method, both statically resolved and LLM-resolved, plus the
	// unannotated/unresolved rows behind the warning icon / "Zoek" action)
	mux.HandleFunc("/api/testcovers", s.handleTestCovers)
	// GET /api/explanations?pr=N → read-only AI unit-explanation read-model
	// (the footer's "AI-omschrijving" per if-containing line/group).
	mux.HandleFunc("/api/explanations", s.handleExplanations)
	// The inbox is owned by the pr_inbox workflow; these endpoints read its
	// read-model (never GitHub directly).
	mux.HandleFunc("/api/inbox", s.handleInbox)
	mux.HandleFunc("/api/inbox/status", s.handleInboxStatus)
}

// handleTaskCodeComment starts a code-comment Workflow Execution (POST) or lists
// executions (GET).
func (s *server) handleTaskCodeComment(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var in CodeCommentInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.File == "" || in.Body == "" {
			http.Error(w, "invalid comment", http.StatusBadRequest)
			return
		}
		if strings.Contains(in.File, "..") {
			http.Error(w, "invalid file", http.StatusBadRequest)
			return
		}
		runID, err := s.tasks.manager.StartCodeComment(r.Context(), in)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
	case http.MethodGet:
		runs, err := s.tasks.engine.Runs()
		if err != nil {
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		out := make([]tembed.RunRecord, 0, len(runs))
		for _, rec := range runs {
			if rec.Workflow == WorkflowTaskCodeComment {
				out = append(out, rec)
			}
		}
		writeJSON(w, http.StatusOK, out)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleWorkflowsList serves GET /api/workflows?pr=N — the read-only list of
// workflow runs scoped to that PR (the "Taken" column in RelatedPanel).
func (s *server) handleWorkflowsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	runs := s.tasks.manager.RunsForPR(pr)
	if runs == nil {
		runs = []WorkflowRunView{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "runs": runs})
}

// handleWorkflows routes /api/workflows/{runID} (GET status) and
// /api/workflows/{runID}/signals/{signalName} (POST signal).
func (s *server) handleWorkflows(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/workflows/")
	if rest == "" || rest == "task_code_comment" || rest == "pr_status" || rest == "resolve_call" || rest == "resolve_test_covers" || rest == "explain_code" || rest == "approve" || rest == "submit_review" || rest == "code_warning" {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	runID := parts[0]

	// POST /api/workflows/{runID}/heartbeat — the UI marks a thread as actively
	// viewed so the server keeps fast-polling GitHub. Writes no state (only
	// in-memory poll timing), so it sits outside the workflow write-boundary.
	if len(parts) == 2 && parts[1] == "heartbeat" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.tasks.manager.Heartbeat(runID)
		writeJSON(w, http.StatusOK, map[string]string{"status": "beat"})
		return
	}

	// POST /api/workflows/{runID}/signals/{signalName}
	if len(parts) == 3 && parts[1] == "signals" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// The inbox "refresh" signal carries no payload — it just asks the
		// pr_inbox workflow to re-fetch now (the UI's on-load re-check).
		if parts[2] == SignalRefresh {
			if err := s.tasks.manager.RefreshInbox(runID); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "refreshing"})
			return
		}
		// The build_relations "rebuild" signal carries no payload — it asks the
		// workflow to recompute the PR's relations now.
		if parts[2] == SignalRebuild {
			if err := s.tasks.engine.SignalWorkflow(runID, SignalRebuild, json.RawMessage("{}")); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "rebuilding"})
			return
		}
		// The "set" signal carries a block's full approved state (rows + call
		// segments) to the per-PR approve tracker — the UI write path for approval.
		if parts[2] == SignalSet {
			var body ApprovalSignal
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid approval", http.StatusBadRequest)
				return
			}
			if body.Viewed != nil {
				if body.File == "" {
					http.Error(w, "invalid viewed request", http.StatusBadRequest)
					return
				}
			} else if body.BlockID == "" {
				http.Error(w, "invalid approval", http.StatusBadRequest)
				return
			}
			if body.Rows == nil {
				body.Rows = []int{}
			}
			if body.Calls == nil {
				body.Calls = []string{}
			}
			if err := s.tasks.engine.SignalWorkflow(runID, SignalSet, body); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "set"})
			return
		}
		// The delete signal carries no comment body — it just asks the workflow
		// to mark the comment "deleting" and remove it (see ReactionSignal).
		if parts[2] == SignalDelete {
			var body struct {
				Author string `json:"author"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body) // author is optional
			sig := ReactionSignal{
				ID: "ui-" + newUIReactionID(), Source: "ui",
				Author: body.Author, Action: "delete",
			}
			if err := s.tasks.manager.Signal(runID, sig); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "deleting"})
			return
		}
		if parts[2] != SignalReply {
			http.Error(w, "unknown signal", http.StatusBadRequest)
			return
		}
		var body struct {
			Author string `json:"author"`
			Body   string `json:"body"`
			Done   bool   `json:"done"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Body == "" {
			http.Error(w, "invalid reaction", http.StatusBadRequest)
			return
		}
		sig := ReactionSignal{
			ID: "ui-" + newUIReactionID(), Source: "ui",
			Author: body.Author, Body: body.Body, Done: body.Done,
		}
		if err := s.tasks.manager.Signal(runID, sig); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "signalled"})
		return
	}

	// GET /api/workflows/{runID}
	if len(parts) == 1 && r.Method == http.MethodGet {
		status, err := s.tasks.engine.Status(runID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"runId": runID, "status": status})
		return
	}
	http.NotFound(w, r)
}

// handleComments serves GET /api/comments?pr=N — the read-only comments +
// reactions read-model the UI renders.
func (s *server) handleComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// ?path=<prefix> does a hierarchical prefix search over the comment paths
	// (e.g. /pr-123 for a whole PR, /pr-123/app/Foo.php for one file); ?pr=N is
	// the plain per-PR list. Both are read-only.
	var (
		list []comments.Comment
		err  error
	)
	if prefix := r.URL.Query().Get("path"); prefix != "" {
		list, err = s.tasks.comments.Search(r.Context(), prefix)
	} else {
		pr := 0
		if v := r.URL.Query().Get("pr"); v != "" {
			pr, _ = strconv.Atoi(v)
		}
		list, err = s.tasks.comments.List(r.Context(), pr)
	}
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []comments.Comment{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleRelations serves GET /api/relations?pr=N — the read-only block-relations
// read-model (parent→child edges) the UI uses to nest children under a block.
func (s *server) handleRelations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.relations.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []relations.Relation{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleResolveCall starts an LLM call-resolution Workflow Execution (POST). It
// is the sanctioned UI write path for the "Zoek" action — the workflow runs
// Haiku, escalates to Sonnet if needed, and writes the callresolve read-model.
func (s *server) handleResolveCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ResolveCallInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 || in.CallerID == "" || len(in.Calls) == 0 {
		http.Error(w, "invalid resolve request", http.StatusBadRequest)
		return
	}
	if strings.Contains(in.CallerFile, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartResolveCall(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleCallResolve serves GET /api/callresolve?pr=N — the read-only
// call-resolution read-model (resolved/found definitions + unresolved calls).
func (s *server) handleCallResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.callresolve.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []callresolve.Entry{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleExplainCode starts an explain_code Workflow Execution (POST) — the
// sanctioned UI write path for the footer's AI unit description. The workflow
// asks Haiku (context-only) to describe the unit's if-statement and writes the
// explanations read-model. Idempotent per unit+code-hash (StartWorkflowID).
func (s *server) handleExplainCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ExplainCodeInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil ||
		in.PR <= 0 || in.BlockID == "" || in.UnitKey == "" || in.CodeHash == "" || in.Code == "" {
		http.Error(w, "invalid explain request", http.StatusBadRequest)
		return
	}
	if strings.Contains(in.File, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartExplainCode(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleExplanations serves GET /api/explanations?pr=N — the read-only AI
// unit-explanation read-model the footer renders.
func (s *server) handleExplanations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.explain.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []explanations.Entry{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleResolveTestCovers starts an LLM test-coverage resolution Workflow
// Execution (POST). It is the sanctioned UI write path for a class-level-only
// coverage annotation (#[CoversClass]/bare "@covers Class") the Go analyzer
// left "unresolved" — the workflow runs Haiku, escalates to Sonnet if needed,
// and writes the testcovers read-model. Never used for an "unannotated" test.
func (s *server) handleResolveTestCovers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ResolveTestCoversInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 || in.TestID == "" || len(in.Classes) == 0 {
		http.Error(w, "invalid resolve request", http.StatusBadRequest)
		return
	}
	if strings.Contains(in.TestFile, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartResolveTestCovers(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleTestCovers serves GET /api/testcovers?pr=N — the read-only
// test-coverage read-model (resolved/found covered methods, plus the
// unannotated/unresolved rows).
func (s *server) handleTestCovers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.testcovers.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []testcovers.Entry{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handlePRStatusStart starts (or reuses) the per-PR pr_status tracker. Starting
// an Execution is the sanctioned UI write path; its start synchronously fetches
// the PR's metadata into the prmeta read-model. The UI calls this on page load.
func (s *server) handlePRStatusStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.EnsurePRStatus(in.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleApproveStart starts (or reuses) the per-PR approve tracker and returns
// its Run ID. Starting an Execution is the sanctioned UI write path; the UI then
// signals approvals to this Run ID via .../signals/set.
func (s *server) handleApproveStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.EnsureApprovals(in.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleApprovals serves GET /api/approvals?pr=N — the read-only approval
// read-model (per block: approved changed rows + call segments) the UI restores
// on load.
func (s *server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.approvals.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []approvals.Approval{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handlePR serves GET /api/pr?pr=N — the read-only PR metadata from the prmeta
// read-model, filled in three progressive stages by the pr_status tracker
// (basics → Claude summary → review/CI statuses). {ok:false} while the tracker
// hasn't fetched anything yet; once ok, fields whose stage hasn't landed yet are
// simply zero values (empty summary/reviewDecision, checksTotal 0, …) so the UI
// can render progressively instead of waiting for every stage.
func (s *server) handlePR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	meta, ok, err := s.tasks.prmeta.Get(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "pr": pr})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "pr": meta.PR, "title": meta.Title, "url": meta.URL, "updatedAt": meta.UpdatedAt,
		"body": meta.Body, "author": meta.Author, "additions": meta.Additions, "deletions": meta.Deletions,
		"changedFiles": meta.ChangedFiles, "headRef": meta.HeadRef,
		"summary": meta.Summary,
		"jiraKey": meta.JiraKey, "jiraTitle": meta.JiraTitle, "jiraDesc": meta.JiraDesc, "jiraUrl": meta.JiraURL,
		"reviewDecision": meta.ReviewDecision, "checksTotal": meta.ChecksTotal, "checksPassed": meta.ChecksPassed,
		"reviewers": meta.Reviewers,
	})
}

// validateSubmitReview checks a submit_review request before it ever reaches
// the workflow/gh: pr must be a positive int, event must be one of GitHub's
// two review-submission actions this app exposes, and — because GitHub
// itself rejects a bodyless REQUEST_CHANGES review — a request-changes
// review must carry a non-empty body (an APPROVE may be bodyless). Trims and
// upper-cases in.Event, and trims in.Body, in place, so a caller that passes
// validation always has a clean value to send on.
func validateSubmitReview(in *SubmitReviewInput) error {
	if in.PR <= 0 {
		return fmt.Errorf("invalid pr")
	}
	in.Event = strings.ToUpper(strings.TrimSpace(in.Event))
	if in.Event != "APPROVE" && in.Event != "REQUEST_CHANGES" {
		return fmt.Errorf("invalid event %q", in.Event)
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Event == "REQUEST_CHANGES" && in.Body == "" {
		return fmt.Errorf("request-changes review requires a non-empty body")
	}
	return nil
}

// handleSubmitReview starts a submit_review Workflow Execution (POST) — the
// sanctioned write path for submitting a real GitHub PR-level review (approve
// or request changes). validateSubmitReview rejects an invalid request (bad
// pr/event, or a bodyless request-changes) before the workflow ever starts.
func (s *server) handleSubmitReview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in SubmitReviewInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if err := validateSubmitReview(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartSubmitReview(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleCodeWarning starts a code_warning Workflow Execution (POST) — an
// agentic Sonnet review of a PR's changed files for risks. The only current
// caller is the "/" menu's "Controleer de hele PR op risico's" (see
// StartCodeWarning); Files is always omitted from the request today (a full
// baseline run) — the field exists for a future incremental fast-follow.
func (s *server) handleCodeWarning(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in CodeWarningInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartCodeWarning(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}
