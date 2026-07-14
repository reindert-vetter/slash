package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

// server holds the shared dependencies for the HTTP handlers.
type server struct {
	db      *sql.DB
	dataDir string
	tasks   *tasks // workflow engine + comments read-model (nil in headless tools)
}

// routes builds the ServeMux: static files + the /api/* bridge.
func (s *server) routes(staticDir string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/blocks", s.handleBlocks)
	mux.HandleFunc("/api/code", s.handleCode)
	mux.HandleFunc("/api/ingest", s.handleIngest)
	mux.HandleFunc("/api/prs", s.handlePRs)
	mux.HandleFunc("/api/prs/search", s.handleSearch)
	if s.tasks != nil {
		s.routesTasks(mux)
	}

	fileServer := http.FileServer(http.Dir(staticDir))
	// App pages are served as static HTML shells; the front-end reads the PR id
	// from the path (/pr/<id>) and the overview lists the PRs (/pr-overview).
	mux.HandleFunc("/pr/", serveFile(staticDir, "index.html"))
	mux.HandleFunc("/pr-overview", serveFile(staticDir, "overview.html"))
	// Everything else is a static asset (/src/*, /overview.html, …); bare "/"
	// has no PR, so send it to the overview.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/pr-overview", http.StatusFound)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
	return mux
}

// serveFile returns a handler that always serves one file from staticDir — the
// SPA shell for the /pr/<id> and /pr-overview routes.
func serveFile(staticDir, name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(staticDir, name))
	}
}

// handlePRs serves GET /api/prs — every ingested PR with its counts, for the
// overview page.
func (s *server) handlePRs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	prs, err := listPRs(s.db)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if prs == nil {
		prs = []PRSummary{}
	}
	writeJSON(w, http.StatusOK, prs)
}

// handleBlocks serves GET /api/blocks?pr=N — the blocks of one PR (a delta).
func (s *server) handleBlocks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr, err := strconv.Atoi(r.URL.Query().Get("pr"))
	if err != nil || pr <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	blocks, err := blocksByPR(s.db, pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if blocks == nil {
		blocks = []Block{}
	}
	writeJSON(w, http.StatusOK, blocks)
}

// handleCode serves GET /api/code?pr=N&file=...&class=...&name=... — the old
// and new source of one block, read from the base/head worktrees of that PR.
// The file must either belong to a stored block of the PR, or — as a fallback
// for e.g. a resolved method-call target in a file the PR didn't touch —
// resolve to a real file inside the head worktree (guards arbitrary reads).
func (s *server) handleCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pr, err := strconv.Atoi(q.Get("pr"))
	if err != nil || pr <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	file := q.Get("file")
	name := q.Get("name")
	class := q.Get("class")
	if file == "" || name == "" || strings.Contains(file, "..") {
		http.Error(w, "invalid block", http.StatusBadRequest)
		return
	}

	ok, err := blockFileExists(s.db, pr, file)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	baseDir, headDir := worktreeDirs(s.dataDir, pr)
	if !ok {
		if _, _, inWorktree := resolveWithinWorktree(headDir, file); !inWorktree {
			http.Error(w, "unknown block", http.StatusNotFound)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"file": file,
		"old":  extractBlockSource(filepath.Join(baseDir, file), file, class, name),
		"new":  extractBlockSource(filepath.Join(headDir, file), file, class, name),
	})
}

// handleIngest serves POST /api/ingest {"pr":N} — runs the ingest pipeline.
func (s *server) handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}

	if s.tasks == nil {
		http.Error(w, "workflow engine unavailable", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ingestTimeout)
	defer cancel()

	res, err := s.tasks.manager.StartIngest(ctx, req.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	// Build the block relations (event→listener, …) now that blocks are stored.
	// The workflow is the only writer; the initial build runs synchronously.
	s.tasks.manager.EnsureRelations(ctx, req.PR)
	writeJSON(w, http.StatusOK, res)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
