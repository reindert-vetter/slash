package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// debug_log.go is the storage half of "Debug mode" (see
// .claude/docs/debug-mode.md): an append-only JSONL file of everything the
// reviewer navigated and clicked while debug mode was on, so Claude can later
// read it and REPRODUCE a reported bug step by step instead of guessing.
//
// One file per data dir, next to settings.json/praise-words.json:
//
//	<dataDir>/debug-log.jsonl — one JSON object per line, oldest first.
//
// It deliberately SURVIVES a server restart (the reviewer's explicit choice) —
// which is exactly why the write side is NOT an operational carve-out like
// run_errors.go's in-memory ring buffer: a durable write must go through a
// workflow Activity, per .claude/rules/workflows-write-boundary.md. The two
// functions below (appendDebugLogFile/clearDebugLogFile) are therefore the
// file's ONLY writers, and both are called exclusively from the debug_log
// Workflow's Activities (workflows.go, WorkflowDebugLog). The READ side
// (readDebugLogTail → GET /api/debug/log) is a pure read and needs no
// carve-out, the same as /api/settings and /api/praisewords.
//
// Why ONE-SHOT Executions instead of one long-lived tracker with a
// WaitSignal loop (the app_settings shape): tembed replays a workflow from the
// beginning at every step, so a tracker accumulating one Signal per flushed
// batch would replay every earlier batch on every new one — quadratic, and
// SignalWorkflow drives that replay inline under the run lock. One Execution
// per batch keeps each replay a single Activity. The completed runs are
// swept by the cleanup workflow (sweepDebugLogRuns, cleanup.go) since the
// file, not the run history, is what has to last.

const (
	// debugLogFileName is the log's name inside the data dir. Gitignored:
	// per-reviewer, and it records that one reviewer's own session.
	debugLogFileName = "debug-log.jsonl"

	// debugLogMaxBatch is how many events one POST may carry. The frontend
	// flushes at 25 (src/debugLog.mjs); the slack is for a long-idle tab
	// dumping its buffer on pagehide.
	debugLogMaxBatch = 500

	// debugLogMaxField is the per-string cap. A logged URL or element label is
	// a reproduction hint, never a payload — anything longer is truncated
	// rather than rejected, so one odd event never loses a whole batch.
	debugLogMaxField = 600

	// debugLogMaxBytes / debugLogKeepLines bound the file: once it grows past
	// the byte cap, the next append rewrites it keeping only the newest
	// debugLogKeepLines lines. Trimming from the FRONT (not rotating to a
	// second file) keeps "read the log" a single cat for Claude.
	debugLogMaxBytes  = 8 << 20
	debugLogKeepLines = 20000
)

// debugLogKinds are the event types the frontend may report. A whitelist
// rather than a free-form string: this file is read back by a tool, so an
// unknown type is a bug to surface at the door, not something to store.
var debugLogKinds = map[string]bool{
	"session":  true, // a page load — the START of a reproduction
	"nav":      true, // the URL changed (the whole nav position lives in it)
	"key":      true,
	"click":    true,
	"action":   true, // a named command/action (see logAction, src/debugLog.mjs)
	"error":    true, // an uncaught throw or unhandled rejection — see src/debugLog.mjs
	"longtask": true, // a main-thread task >50ms (PerformanceObserver), see src/debugLog.mjs
}

// DebugLogEvent is one recorded step. Everything is optional except Type: a
// "session" event carries only the URL, a "key" event a key plus modifiers.
type DebugLogEvent struct {
	// T is the CLIENT clock in ms since the epoch — kept next to the server's
	// own timestamp because the interesting thing about two events is the gap
	// between them, which only the client can see accurately.
	T      int64  `json:"t,omitempty"`
	Type   string `json:"type"`
	URL    string `json:"url,omitempty"`
	Key    string `json:"key,omitempty"`
	Mods   string `json:"mods,omitempty"`   // e.g. "cmd+shift"
	Target string `json:"target,omitempty"` // data-testid (or tag) of the element
	Detail string `json:"detail,omitempty"`
	// Message/Stack carry an "error" event's uncaught-exception/rejection text
	// (window.onerror / unhandledrejection). Stack is truncated client-side
	// already (see src/debugLog.mjs) but re-clamped here too, at the door.
	Message string `json:"message,omitempty"`
	Stack   string `json:"stack,omitempty"`
	// DurationMs carries a "longtask" event's PerformanceObserver duration.
	DurationMs float64 `json:"durationMs,omitempty"`
	// HeapKB is an optional heap-size sample (performance.memory, Chrome
	// only) piggy-backed onto a "nav"/"session" event so a growing trend is
	// visible in the ordinary timeline without a dedicated event per sample.
	// See ".claude/docs/frontend-memory.md" for the measured leak this is a
	// cheap, ad-hoc vantage point on — not a replacement for that harness.
	HeapKB int64 `json:"heapKB,omitempty"`
}

// DebugLogInput is one debug_log Execution's whole input: a batch to append,
// or the reviewer's "Log wissen" from the settings page.
type DebugLogInput struct {
	Kind    string          `json:"kind"` // "append" | "clear"
	Session string          `json:"session,omitempty"`
	Page    string          `json:"page,omitempty"`
	Events  []DebugLogEvent `json:"events,omitempty"`
}

// debugLogRecord is one written line: the event, plus the session/page it
// belongs to and the server's own timestamp.
type debugLogRecord struct {
	At      string `json:"at"`
	Session string `json:"session,omitempty"`
	Page    string `json:"page,omitempty"`
	DebugLogEvent
}

// debugLogMu serializes the appends. One process writes this file, but several
// tabs can flush at the same moment, and a trim rewrites the whole file.
var debugLogMu sync.Mutex

func debugLogPath(dir string) string { return filepath.Join(dir, debugLogFileName) }

// validateDebugLogInput normalizes and bounds a batch BEFORE it reaches the
// engine — the same "validate at the door" discipline the app_settings signal
// branch follows (tasks_api.go). Returns an error for a request that is
// structurally wrong (unknown kind, empty/oversized batch); an individual
// field that is merely too long is truncated, never fatal.
func validateDebugLogInput(in *DebugLogInput) error {
	switch in.Kind {
	case "clear":
		in.Events = nil
		return nil
	case "append":
	default:
		return fmt.Errorf("invalid debug log kind %q", in.Kind)
	}
	if len(in.Events) == 0 {
		return fmt.Errorf("no events")
	}
	if len(in.Events) > debugLogMaxBatch {
		return fmt.Errorf("too many events (%d > %d)", len(in.Events), debugLogMaxBatch)
	}
	in.Session = clampDebugField(in.Session)
	in.Page = clampDebugField(in.Page)
	for i := range in.Events {
		e := &in.Events[i]
		if !debugLogKinds[e.Type] {
			return fmt.Errorf("invalid debug log event type %q", e.Type)
		}
		e.URL = clampDebugField(e.URL)
		e.Key = clampDebugField(e.Key)
		e.Mods = clampDebugField(e.Mods)
		e.Target = clampDebugField(e.Target)
		e.Detail = clampDebugField(e.Detail)
		e.Message = clampDebugField(e.Message)
		e.Stack = clampDebugField(e.Stack)
		if e.DurationMs < 0 {
			e.DurationMs = 0
		}
		if e.HeapKB < 0 {
			e.HeapKB = 0
		}
	}
	return nil
}

// clampDebugField trims a field to debugLogMaxField and strips the newlines
// that would otherwise break the one-object-per-line contract (the JSON
// encoder would escape them, but a truncated label reads better on one line).
func clampDebugField(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, s)
	if len(s) > debugLogMaxField {
		return s[:debugLogMaxField] + "…"
	}
	return s
}

// appendDebugLogFile appends one validated batch and returns how many lines it
// wrote. Called ONLY from the debug_log workflow's "appendDebugLog" Activity.
// Uses the real wall clock, which is fine: an Activity body is exempt from the
// determinism rule (see .claude/rules/workflow-determinism.md).
func appendDebugLogFile(dir string, in DebugLogInput) (int, error) {
	if dir == "" {
		return 0, fmt.Errorf("no data dir")
	}
	debugLogMu.Lock()
	defer debugLogMu.Unlock()

	path := debugLogPath(dir)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return 0, err
	}
	now := time.Now().Format(time.RFC3339Nano)
	var buf strings.Builder
	for _, e := range in.Events {
		line, err := json.Marshal(debugLogRecord{At: now, Session: in.Session, Page: in.Page, DebugLogEvent: e})
		if err != nil {
			continue // one unencodable event never loses the batch
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	if _, err := f.WriteString(buf.String()); err != nil {
		f.Close()
		return 0, err
	}
	if err := f.Close(); err != nil {
		return 0, err
	}
	if st, err := os.Stat(path); err == nil && st.Size() > debugLogMaxBytes {
		if err := trimDebugLogFile(path, debugLogKeepLines); err != nil {
			return len(in.Events), err
		}
	}
	return len(in.Events), nil
}

// trimDebugLogFile rewrites path keeping only its newest keep lines, written
// atomically (temp file + rename in the same directory) so a crash mid-trim
// can never leave a half-written log — the same discipline
// saveMentionAliases/savePraiseWordsFile follow for their own files.
func trimDebugLogFile(path string, keep int) error {
	lines, err := readDebugLogLines(path)
	if err != nil {
		return err
	}
	if len(lines) <= keep {
		return nil
	}
	return writeDebugLogLines(path, lines[len(lines)-keep:])
}

// clearDebugLogFile empties the log — the settings page's "Log wissen", so a
// reviewer can start a clean reproduction. Called ONLY from the debug_log
// workflow's "clearDebugLog" Activity. Truncates rather than removes, so the
// file keeps existing (and keeps its permissions) for the next append.
func clearDebugLogFile(dir string) error {
	if dir == "" {
		return fmt.Errorf("no data dir")
	}
	debugLogMu.Lock()
	defer debugLogMu.Unlock()
	return writeDebugLogLines(debugLogPath(dir), nil)
}

func writeDebugLogLines(path string, lines []string) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+debugLogFileName+".*")
	if err != nil {
		return err
	}
	w := bufio.NewWriter(tmp)
	for _, l := range lines {
		w.WriteString(l)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}

func readDebugLogLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" {
			lines = append(lines, line)
		}
	}
	return lines, sc.Err()
}

// readDebugLogTail returns the newest limit lines (oldest first) plus the
// total line count — the read model behind GET /api/debug/log, and the count
// the settings page shows. limit <= 0 means "everything".
func readDebugLogTail(dir string, limit int) ([]string, int, error) {
	debugLogMu.Lock()
	defer debugLogMu.Unlock()
	lines, err := readDebugLogLines(debugLogPath(dir))
	if err != nil {
		return nil, 0, err
	}
	total := len(lines)
	if limit > 0 && total > limit {
		lines = lines[total-limit:]
	}
	return lines, total, nil
}

// handleDebugLog serves GET /api/debug/log — read-only, so it needs no
// workflow (see the write-boundary rule). Two shapes on purpose:
//
//	?format=jsonl → the raw file tail as text/plain, i.e. exactly what
//	                Claude wants to read when reproducing a bug;
//	default       → {ok, total, events:[…]} for the settings page's counter.
func (s *server) handleDebugLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, _ = strconv.Atoi(v)
	}
	lines, total, err := readDebugLogTail(s.dataDir, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if r.URL.Query().Get("format") == "jsonl" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for _, l := range lines {
			w.Write([]byte(l + "\n"))
		}
		return
	}
	events := make([]json.RawMessage, 0, len(lines))
	for _, l := range lines {
		events = append(events, json.RawMessage(l))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "total": total, "events": events})
}
