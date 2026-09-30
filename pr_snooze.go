package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/prsnooze"
)

// pr_snooze — "hide this PR on /pr-overview until …", from the row popover's
// "Snooze…" item (see "Snoozen" in .claude/docs/pr-overview.md). One long-lived
// tracker per process: the Signal carries its own repo, because the overview
// lists PRs from every configured repo.

const (
	// WorkflowPrSnooze is the Workflow Type that persists snoozes into the
	// prsnooze read-model. Never completes.
	WorkflowPrSnooze = "pr_snooze"
	// SignalPrSnooze delivers one PrSnoozeSignal.
	SignalPrSnooze = "pr_snooze"
)

// The snooze options the popover offers. The wake-up MOMENT is computed inside
// the workflow from w.Now() (snoozeUntil), never taken from the request.
const (
	SnoozeTomorrow   = "tomorrow_8"    // tomorrow 08:00
	SnoozeNextMonday = "next_monday_8" // Monday of next week, 08:00
	SnoozeSevenDays  = "days_7"        // in 7 days, 08:00
	SnoozeClear      = "clear"         // lift the snooze now
)

// validSnoozeOption reports whether option is one of the four above.
func validSnoozeOption(option string) bool {
	switch option {
	case SnoozeTomorrow, SnoozeNextMonday, SnoozeSevenDays, SnoozeClear:
		return true
	}
	return false
}

// PrSnoozeInput starts the pr_snooze tracker. Empty on purpose — one per process.
type PrSnoozeInput struct{}

// PrSnoozeSignal is one snooze/un-snooze request. Repo is the canonical repo
// string ("" = primary), already validated by the handler.
type PrSnoozeSignal struct {
	Repo   string `json:"repo,omitempty"`
	PR     int    `json:"pr"`
	Option string `json:"option"`
}

// snoozeUntil maps an option onto its wake-up moment, as 08:00 local time on
// the chosen day. Pure — the workflow passes it w.Now(), the unit test a fixed
// clock. time.Date normalises an overflowing day and keeps 08:00 wall-clock
// time across a DST switch. "Next Monday" is the Monday of NEXT calendar week
// (ISO, weeks start on Monday): on a Monday that is +7 days, on a Sunday it is
// tomorrow. ok is false for an unknown option (and for SnoozeClear).
func snoozeUntil(now time.Time, option string) (until time.Time, ok bool) {
	days := 0
	switch option {
	case SnoozeTomorrow:
		days = 1
	case SnoozeNextMonday:
		days = 7 - (int(now.Weekday())+6)%7
	case SnoozeSevenDays:
		days = 7
	default:
		return time.Time{}, false
	}
	y, mo, d := now.Date()
	return time.Date(y, mo, d+days, 8, 0, 0, 0, now.Location()), true
}

// prSnoozeWorkflow persists snoozes. Deterministic: every Signal reads the clock
// once via w.Now() (recorded, so replay sees the same instant) and then runs
// exactly one Activity — savePrSnooze or clearPrSnooze — chosen from the Signal
// alone. An unknown option (the handler already rejects those) runs nothing.
func prSnoozeWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	for {
		var sig PrSnoozeSignal
		w.WaitSignal(SignalPrSnooze, &sig)
		if sig.Option == SnoozeClear {
			if err := w.ExecuteActivity("clearPrSnooze", sig, nil); err != nil {
				return nil, fmt.Errorf("clear pr snooze: %w", err)
			}
			continue
		}
		now := w.Now().In(time.Local)
		until, ok := snoozeUntil(now, sig.Option)
		if !ok {
			continue
		}
		arg := prSnoozeSave{Repo: sig.Repo, PR: sig.PR, Until: until, At: now}
		if err := w.ExecuteActivity("savePrSnooze", arg, nil); err != nil {
			return nil, fmt.Errorf("save pr snooze: %w", err)
		}
	}
}

// prSnoozeSave is savePrSnooze's input.
type prSnoozeSave struct {
	Repo  string    `json:"repo,omitempty"`
	PR    int       `json:"pr"`
	Until time.Time `json:"until"`
	At    time.Time `json:"at"`
}

// registerPrSnoozeActivities registers the two write Activities. The prsnooze
// module is the only writer of its read-model; a nil store makes both no-ops.
func (m *TaskManager) registerPrSnoozeActivities(engine *tembed.Engine) {
	engine.RegisterActivity("savePrSnooze", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg prSnoozeSave
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prsnooze == nil {
			return nil, nil
		}
		return nil, m.prsnooze.Set(ctx, arg.Repo, arg.PR, arg.Until, arg.At)
	})
	engine.RegisterActivity("clearPrSnooze", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PrSnoozeSignal
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prsnooze == nil {
			return nil, nil
		}
		return nil, m.prsnooze.Clear(ctx, arg.Repo, arg.PR)
	})
}

// EnsurePrSnooze ensures the single pr_snooze tracker exists (starting one if
// none is live) and returns its Run ID; reused across restarts.
func (m *TaskManager) EnsurePrSnooze() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.prSnoozeRun != "" {
		return m.prSnoozeRun, nil
	}
	if runs, err := m.engine.Runs(); err == nil {
		for _, r := range runs {
			if r.Workflow == WorkflowPrSnooze && (r.Status == tembed.StatusRunning || r.Status == tembed.StatusWaiting) {
				m.prSnoozeRun = r.ID
				return r.ID, nil
			}
		}
	}
	id, err := m.engine.StartWorkflow(WorkflowPrSnooze, PrSnoozeInput{})
	if err != nil {
		return "", err
	}
	m.prSnoozeRun = id
	return id, nil
}

// PrSnoozes lists every snooze still pending right now — read-only, backs
// GET /api/prsnoozes.
func (m *TaskManager) PrSnoozes(ctx context.Context) ([]prsnooze.Snooze, error) {
	if m.prsnooze == nil {
		return []prsnooze.Snooze{}, nil
	}
	return m.prsnooze.List(ctx, time.Now())
}

// handlePrSnoozeStart serves POST /api/workflows/pr_snooze: ensure the tracker
// and return its Run ID. The UI then signals .../signals/pr_snooze.
func (s *server) handlePrSnoozeStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	runID, err := s.tasks.manager.EnsurePrSnooze()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handlePrSnoozes serves GET /api/prsnoozes — read-only.
func (s *server) handlePrSnoozes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	list, err := s.tasks.manager.PrSnoozes(r.Context())
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "snoozes": list})
}

// decodePrSnoozeSignal validates a pr_snooze Signal body before it reaches the
// engine: a known option, a positive PR, a configured repo (canonicalised).
func decodePrSnoozeSignal(r *http.Request) (PrSnoozeSignal, error) {
	var body PrSnoozeSignal
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return body, fmt.Errorf("invalid pr_snooze")
	}
	if body.PR <= 0 || !validSnoozeOption(body.Option) || !knownRepo(body.Repo) {
		return body, fmt.Errorf("invalid pr_snooze")
	}
	body.Repo = canonRepo(body.Repo)
	return body, nil
}
