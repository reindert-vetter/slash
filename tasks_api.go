package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/reindert-vetter/tembed"
	"slash/modules/comments"
	"slash/modules/github"
)

// tasks holds the workflow engine + the comments module read side. It is built
// once at server start.
type tasks struct {
	engine   *tembed.Engine
	manager  *TaskManager
	comments *comments.Module
}

// newTasks builds the tembed engine (SQLite + JSONL, so comments live in the
// workflow event history AND in jsonl files), the comments module, and the
// github module, then recovers in-flight executions and resumes their pollers.
func newTasks(ctx context.Context, dataDir, repo string) (*tasks, func() error, error) {
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
	mgr := NewTaskManager(engine, github.New(repo), cs)

	if err := engine.Recover(); err != nil {
		return nil, nil, err
	}
	mgr.ResumePolling(ctx)

	closeFn := func() error {
		_ = sq.Close()
		return cs.Close()
	}
	return &tasks{engine: engine, manager: mgr, comments: cs}, closeFn, nil
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
		rootID, _ := m.rootID(r.ID)
		if rootID != 0 {
			go m.poll(ctx, r.ID, input.PR, rootID)
		}
	}
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
	// GET /api/comments?pr=N → read-only comments + reactions for the UI
	mux.HandleFunc("/api/comments", s.handleComments)
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

// handleWorkflows routes /api/workflows/{runID} (GET status) and
// /api/workflows/{runID}/signals/{signalName} (POST signal).
func (s *server) handleWorkflows(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/workflows/")
	if rest == "" || rest == "task_code_comment" {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	runID := parts[0]

	// POST /api/workflows/{runID}/signals/{signalName}
	if len(parts) == 3 && parts[1] == "signals" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
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
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.comments.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []comments.Comment{}
	}
	writeJSON(w, http.StatusOK, list)
}
