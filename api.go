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
	if s.tasks != nil {
		s.routesTasks(mux)
	}
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))
	return mux
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
// The block must belong to a stored block of the PR (guards arbitrary reads).
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
	if !ok {
		http.Error(w, "unknown block", http.StatusNotFound)
		return
	}

	baseDir, headDir := worktreeDirs(s.dataDir, pr)
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

	ctx, cancel := context.WithTimeout(r.Context(), ingestTimeout)
	defer cancel()

	res, err := ingestPR(ctx, s.db, s.dataDir, req.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
