package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/prignore"
)

// pr_ignore — "stop listing this PR under Migrations & API changes", from the
// row popover's "Negeren" item (see "Negeren" in .claude/docs/pr-overview.md).
// One long-lived tracker per process, same shape as pr_snooze; the Signal
// carries its own repo.

const (
	// WorkflowPrIgnore persists ignores into the prignore read-model. Never completes.
	WorkflowPrIgnore = "pr_ignore"
	// SignalPrIgnore delivers one PrIgnoreSignal.
	SignalPrIgnore = "pr_ignore"
)

// PrIgnoreInput starts the pr_ignore tracker. Empty — one per process.
type PrIgnoreInput struct{}

// PrIgnoreSignal is one ignore/un-ignore request (Ignore=false lifts it).
type PrIgnoreSignal struct {
	Repo   string `json:"repo,omitempty"`
	PR     int    `json:"pr"`
	Ignore bool   `json:"ignore"`
}

// prIgnoreWorkflow persists ignores. Deterministic: every Signal reads the clock
// once via w.Now() and then runs exactly one Activity chosen from the Signal.
func prIgnoreWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	for {
		var sig PrIgnoreSignal
		w.WaitSignal(SignalPrIgnore, &sig)
		if !sig.Ignore {
			if err := w.ExecuteActivity("clearPrIgnore", sig, nil); err != nil {
				return nil, fmt.Errorf("clear pr ignore: %w", err)
			}
			continue
		}
		arg := prIgnoreSave{Repo: sig.Repo, PR: sig.PR, At: w.Now()}
		if err := w.ExecuteActivity("savePrIgnore", arg, nil); err != nil {
			return nil, fmt.Errorf("save pr ignore: %w", err)
		}
	}
}

// prIgnoreSave is savePrIgnore's input.
type prIgnoreSave struct {
	Repo string    `json:"repo,omitempty"`
	PR   int       `json:"pr"`
	At   time.Time `json:"at"`
}

func (m *TaskManager) registerPrIgnoreActivities(engine *tembed.Engine) {
	engine.RegisterActivity("savePrIgnore", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg prIgnoreSave
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prignore == nil {
			return nil, nil
		}
		return nil, m.prignore.Set(ctx, arg.Repo, arg.PR, arg.At)
	})
	engine.RegisterActivity("clearPrIgnore", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PrIgnoreSignal
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prignore == nil {
			return nil, nil
		}
		return nil, m.prignore.Clear(ctx, arg.Repo, arg.PR)
	})
}

// EnsurePrIgnore ensures the single pr_ignore tracker exists and returns its Run ID.
func (m *TaskManager) EnsurePrIgnore() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.prIgnoreRun != "" {
		return m.prIgnoreRun, nil
	}
	if runs, err := m.engine.Runs(); err == nil {
		for _, r := range runs {
			if r.Workflow == WorkflowPrIgnore && (r.Status == tembed.StatusRunning || r.Status == tembed.StatusWaiting) {
				m.prIgnoreRun = r.ID
				return r.ID, nil
			}
		}
	}
	id, err := m.engine.StartWorkflow(WorkflowPrIgnore, PrIgnoreInput{})
	if err != nil {
		return "", err
	}
	m.prIgnoreRun = id
	return id, nil
}

// PrIgnores lists every ignore — read-only, backs GET /api/prignores.
func (m *TaskManager) PrIgnores(ctx context.Context) ([]prignore.Ignore, error) {
	if m.prignore == nil {
		return []prignore.Ignore{}, nil
	}
	return m.prignore.List(ctx)
}

// handlePrIgnoreStart serves POST /api/workflows/pr_ignore.
func (s *server) handlePrIgnoreStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	runID, err := s.tasks.manager.EnsurePrIgnore()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handlePrIgnores serves GET /api/prignores — read-only.
func (s *server) handlePrIgnores(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	list, err := s.tasks.manager.PrIgnores(r.Context())
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignores": list})
}

// decodePrIgnoreSignal validates a pr_ignore Signal body: a positive PR and a
// configured repo (canonicalised).
func decodePrIgnoreSignal(r *http.Request) (PrIgnoreSignal, error) {
	var body PrIgnoreSignal
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return body, fmt.Errorf("invalid pr_ignore")
	}
	if body.PR <= 0 || !knownRepo(body.Repo) {
		return body, fmt.Errorf("invalid pr_ignore")
	}
	body.Repo = canonRepo(body.Repo)
	return body, nil
}
