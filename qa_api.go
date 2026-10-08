// qa_api.go — the endpoints behind the /qa/<pr> page (src/qa.mjs). One write
// (starting a qa_run Execution), reads of the tembed store and the volatile
// snapshot, one file read (a screenshot), and the in-memory cancel. See
// .claude/docs/qa-page.md.
package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"
)

// qaRoundView is one round on the page: the run plus its recorded result once
// it finished.
type qaRoundView struct {
	RunID        string       `json:"runId"`
	Round        int          `json:"round"`
	Status       string       `json:"status"`
	Instructions string       `json:"instructions,omitempty"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
	Result       *qaRunResult `json:"result,omitempty"`
}

// qaRoundsFor lists this PR's qa_run runs, oldest first. READ-only (the tembed
// store), so no write-boundary carve-out is needed.
func (m *TaskManager) qaRoundsFor(repo string, pr int) []qaRoundView {
	out := []qaRoundView{}
	if m == nil || m.engine == nil {
		return out
	}
	runs, err := m.engine.Runs()
	if err != nil {
		return out
	}
	for _, r := range runs {
		if r.Workflow != WorkflowQARun {
			continue
		}
		raw, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var in QARunInput
		if json.Unmarshal(raw, &in) != nil || in.PR != pr || canonRepo(in.Repo) != repo {
			continue
		}
		v := qaRoundView{RunID: r.ID, Round: in.Round, Status: r.Status, Instructions: in.Instructions, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
		if r.Status == tembed.StatusCompleted {
			var res qaRunResult
			if m.engine.Result(r.ID, &res) == nil {
				v.Result = &res
			}
		}
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// handleQARunStart serves POST /api/workflows/qa_run {pr, instructions?}. The
// round number and the previous round's run id are derived HERE and travel in
// the input, so the workflow body never has to read anything itself. A round
// already running for this PR → 409 (one local stack, one checkout).
func (s *server) handleQARunStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in QARunInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid qa run request", http.StatusBadRequest)
		return
	}
	in.Repo = canonRepo(in.Repo)
	in.Instructions = strings.TrimSpace(in.Instructions)
	if len(in.Instructions) > 4000 {
		in.Instructions = in.Instructions[:4000]
	}
	if qaRunRunning(in.Repo, in.PR) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "qa run already running"})
		return
	}
	rounds := s.tasks.manager.qaRoundsFor(in.Repo, in.PR)
	for _, rd := range rounds {
		if rd.Status == tembed.StatusRunning {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "qa run already running"})
			return
		}
	}
	in.Round = len(rounds) + 1
	in.PrevRunID = ""
	for i := len(rounds) - 1; i >= 0; i-- {
		if rounds[i].Result != nil && rounds[i].Result.Report != nil {
			in.PrevRunID = rounds[i].RunID
			break
		}
	}
	runID, err := s.tasks.manager.StartQARun(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runId": runID, "round": in.Round})
}

// handleQA serves GET /api/qa?pr=N → {ok, rounds, progress?}. Read-only.
func (s *server) handleQA(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr, _ := strconv.Atoi(r.URL.Query().Get("pr"))
	if pr <= 0 {
		http.Error(w, "pr required", http.StatusBadRequest)
		return
	}
	repo := queryRepo(r)
	out := map[string]any{"ok": true, "pr": pr, "rounds": s.tasks.manager.qaRoundsFor(repo, pr)}
	if p, ok := qaRunProgressFor(repo, pr); ok {
		out["progress"] = p
	}
	writeJSON(w, http.StatusOK, out)
}

// handleQAImage serves GET /api/qa/image?pr=N&run=ID&file=NAME — one
// screenshot of one round. Both path segments are validated (qaRunIDRe,
// qaImageFileRe) and the run must really be a qa_run of this PR before
// anything is joined onto the data dir.
func (s *server) handleQAImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pr, _ := strconv.Atoi(q.Get("pr"))
	runID, file := q.Get("run"), q.Get("file")
	if pr <= 0 || !qaRunIDRe.MatchString(runID) || !qaImageFileRe.MatchString(file) {
		http.Error(w, "invalid image request", http.StatusBadRequest)
		return
	}
	m := s.tasks.manager
	if m == nil || m.engine == nil {
		http.NotFound(w, r)
		return
	}
	raw, err := m.engine.Input(runID)
	var in QARunInput
	if err != nil || json.Unmarshal(raw, &in) != nil || in.PR != pr {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(qaRunDir(m.dataDir, pr, runID), file)
	if fi, err := os.Stat(path); err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, path)
}

// handleQACancel serves POST /api/qa/cancel {pr} — stops the running round
// right now. An in-memory context.CancelFunc only (chat_cancel.go's
// registry), never a Signal, for the same reason as /api/test-run/cancel; the
// durable outcome is the run's own recorded "cancelled" result.
func (s *server) handleQACancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.PR <= 0 {
		http.Error(w, "pr required", http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cancelled": cancelChatTurn(qaRunCancelID(body.PR))})
}
