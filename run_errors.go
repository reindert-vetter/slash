package main

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
)

// This file surfaces the two ways background work can go wrong without the
// reviewer ever noticing, and serves both to GET /api/problems (read-only) for
// the "Mislukte taken" block at the bottom of /pr-overview:
//
//   (a) a workflow run that ended in tembed.StatusFailed — durable, in the
//       tembed store, so FailedRuns below is a pure read of engine.Runs()
//       (repo-wide, unlike RunsForPR which filters on the run input's "pr");
//   (b) an error that only ever reached the log — poller/startup glue that
//       isn't a workflow run at all (e.g. "import comments: fetch review
//       comments pr=970099: ... exit status 1"). Nothing records those, so the
//       ring buffer below mirrors them.
//
// The buffer is a LOG MIRROR, not an error classifier: every TaskManager.logf
// call site reports something that was skipped, so all of them go in and none
// is judged more important than another. Purely in memory and lost on restart
// — it touches no module/read-model/workflow history, so it falls outside the
// workflows-write-boundary rule, the same carve-out as the heartbeat map and
// ingest_progress.go (see .claude/rules/workflows-write-boundary.md). Anything
// that should genuinely survive a restart would have to go through a workflow.

// problemLogCap is how many log lines the ring buffer keeps (newest wins, the
// oldest falls out). No time limit: the buffer dies with the process anyway,
// and a startup failure is exactly the thing you want to still find hours
// later.
const problemLogCap = 100

// failedRunCap is how many failed runs GET /api/problems reports (newest
// updated first).
const failedRunCap = 50

// LogProblem is one mirrored log line.
type LogProblem struct {
	At time.Time `json:"at"`
	// Scope is the leading "<subsystem>:" of the log line ("import comments",
	// "pr_status", "tembed", …), or "" when the line has no such prefix.
	Scope string `json:"scope"`
	// PR is the PR number parsed out of a "pr=<n>" fragment, or 0 when the line
	// names none (a repo-wide tracker, say).
	PR      int    `json:"pr"`
	Message string `json:"message"`
}

// FailedRun is one workflow run that ended in tembed.StatusFailed.
type FailedRun struct {
	RunID     string    `json:"runId"`
	Workflow  string    `json:"workflow"`
	PR        int       `json:"pr"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Error is the recorded failure message, or "" when the run's history holds
	// no readable one.
	Error string `json:"error"`
}

var (
	problemMu  sync.Mutex
	problemLog []LogProblem // oldest first, capped at problemLogCap
)

// rePRField finds the "pr=<n>" fragment every PR-scoped log line carries.
var rePRField = regexp.MustCompile(`\bpr=(\d+)`)

// recordProblem appends one already-formatted log line to the ring buffer.
func recordProblem(msg string) {
	msg = strings.TrimSpace(msg)
	if msg == "" {
		return
	}
	p := LogProblem{At: time.Now(), Scope: problemScope(msg), Message: msg}
	if m := rePRField.FindStringSubmatch(msg); m != nil {
		p.PR, _ = strconv.Atoi(m[1])
	}
	problemMu.Lock()
	defer problemMu.Unlock()
	problemLog = append(problemLog, p)
	if len(problemLog) > problemLogCap {
		problemLog = problemLog[len(problemLog)-problemLogCap:]
	}
}

// problemScope returns the subsystem prefix before the first ":" — but only
// when it really looks like one (short, no "=" in it), so a colon inside a
// plain sentence never becomes a scope.
func problemScope(msg string) string {
	i := strings.IndexByte(msg, ':')
	if i <= 0 || i > 40 {
		return ""
	}
	head := msg[:i]
	if strings.ContainsAny(head, "=") {
		return ""
	}
	return head
}

// loggedProblems returns the mirrored log lines, newest first.
func loggedProblems() []LogProblem {
	problemMu.Lock()
	defer problemMu.Unlock()
	out := make([]LogProblem, 0, len(problemLog))
	for i := len(problemLog) - 1; i >= 0; i-- {
		out = append(out, problemLog[i])
	}
	return out
}

// resetProblemLog clears the buffer (tests only).
func resetProblemLog() {
	problemMu.Lock()
	defer problemMu.Unlock()
	problemLog = nil
}

// mirrorManagerLogs wraps m's log function so every line it writes also lands
// in the buffer. m.logf is the single funnel every glue-level error in
// workflows.go already goes through (~40 call sites), so this one wrapper
// covers them all — no per-site change, and a new call site is mirrored for
// free.
func mirrorManagerLogs(m *TaskManager) {
	base := m.logf
	if base == nil {
		base = log.Printf
	}
	m.logf = func(format string, args ...any) {
		base(format, args...)
		recordProblem(fmt.Sprintf(format, args...))
	}
}

// problemMirrorLogger is the same mirror for the tembed engine's own log lines
// (e.g. "run X uses unregistered workflow", which only ever appear at
// startup/recovery).
func problemMirrorLogger() tembed.Option {
	return tembed.WithLogger(func(format string, args ...any) {
		log.Printf(format, args...)
		recordProblem(fmt.Sprintf(format, args...))
	})
}

// FailedRuns lists, newest-updated first, up to limit workflow runs that ended
// in tembed.StatusFailed — repo-wide, so a per-repo tracker (no "pr" in its
// input, hence PR 0) is included too. Read-only: it only inspects
// engine.Runs()/Input()/Result(), it never starts or signals anything.
func (m *TaskManager) FailedRuns(limit int) []FailedRun {
	runs, err := m.engine.Runs()
	if err != nil {
		return nil
	}
	out := make([]FailedRun, 0, len(runs))
	for _, r := range runs {
		if r.Status != tembed.StatusFailed {
			continue
		}
		f := FailedRun{RunID: r.ID, Workflow: r.Workflow, UpdatedAt: r.UpdatedAt}
		if in, err := m.engine.Input(r.ID); err == nil {
			var input struct {
				PR int `json:"pr"`
			}
			if json.Unmarshal(in, &input) == nil {
				f.PR = input.PR
			}
		}
		// Result reports a failed run as an error carrying the recorded
		// failure message — the only readable form of it.
		if err := m.engine.Result(r.ID, nil); err != nil {
			f.Error = err.Error()
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}
