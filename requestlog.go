package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// The "request-log" setting: where the Plug&Pay production access log lives
// locally — a DuckDB file (usually identifier.db in the plug-and-pay repo
// root, see that repo's own search-in-requests skill), table `requests`. The
// planning page's chat (planChatReply, plan_workflow.go) may query it itself,
// read-only, through `duckdb -readonly <path>`.
//
// Source of truth: <appDataDir>/request-log.json ({"path":"..."}). A missing
// file means the default, defaultRequestLogPath. An explicitly EMPTY path is a
// real value ("don't use a request log").
//
// The reviewer may point at the `.wal` next to the database too; that is
// normalized to the database itself, because DuckDB replays its own WAL when
// it opens the `.db` and cannot open a `.wal` on its own.
//
// WRITE BOUNDARY: the read (GET /api/requestlog) is a pure read, same
// carve-out as /api/touchedsection. The write goes through the app_settings
// tracker (Kind "requestLog") whose Activity "saveRequestLog" calls
// saveRequestLogFile — the only writer of the file.

const defaultRequestLogPath = "/Users/reindert/dev/plug-and-pay/identifier.db"

// requestLogPathPattern bounds what may reach the claude CLI as part of a
// tool permission pattern (`Bash(duckdb -readonly <path>:*)`) and duckdb as an
// argument: an absolute path of plain path characters only — no spaces, no
// quotes, no shell metacharacters, no parentheses (they would close the
// permission pattern early).
var requestLogPathPattern = regexp.MustCompile(`^/[A-Za-z0-9._/-]+\.db$`)

var (
	requestLogMu   sync.RWMutex
	requestLogPath = defaultRequestLogPath
)

func requestLogFile(dir string) string { return filepath.Join(dir, "request-log.json") }

// normalizeRequestLogPath trims, strips a trailing `.wal` and validates. An
// empty input is valid (it switches the request log off); ok=false means the
// input must be rejected.
func normalizeRequestLogPath(p string) (string, bool) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", true
	}
	p = strings.TrimSuffix(p, ".wal")
	if strings.Contains(p, "..") {
		return "", false
	}
	p = filepath.Clean(p)
	if !requestLogPathPattern.MatchString(p) {
		return "", false
	}
	return p, true
}

// loadRequestLogFile applies the stored setting; a missing or unreadable file
// keeps the default.
func loadRequestLogFile(dir string) {
	path := defaultRequestLogPath
	if raw, err := os.ReadFile(requestLogFile(dir)); err == nil {
		var v struct {
			Path *string `json:"path"`
		}
		if json.Unmarshal(raw, &v) == nil && v.Path != nil {
			if p, ok := normalizeRequestLogPath(*v.Path); ok {
				path = p
			}
		}
	}
	requestLogMu.Lock()
	requestLogPath = path
	requestLogMu.Unlock()
}

func saveRequestLogFile(dir, path string) error {
	p, ok := normalizeRequestLogPath(path)
	if !ok {
		return fmt.Errorf("requestlog: invalid path %q", path)
	}
	raw, err := json.Marshal(map[string]string{"path": p})
	if err != nil {
		return err
	}
	tmp := requestLogFile(dir) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return fmt.Errorf("requestlog: write temp file: %w", err)
	}
	if err := os.Rename(tmp, requestLogFile(dir)); err != nil {
		return fmt.Errorf("requestlog: rename temp file: %w", err)
	}
	requestLogMu.Lock()
	requestLogPath = p
	requestLogMu.Unlock()
	return nil
}

// configuredRequestLog is the configured path ("" when switched off).
func configuredRequestLog() string {
	requestLogMu.RLock()
	defer requestLogMu.RUnlock()
	return requestLogPath
}

// usableRequestLog is the configured path when that file really exists, else
// "" — what the plan chat actually gets access to.
func usableRequestLog() string {
	p := configuredRequestLog()
	if p == "" {
		return ""
	}
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		return ""
	}
	return p
}

// handleRequestLog serves GET /api/requestlog →
// {"ok":true,"path":"...","exists":bool}.
func (s *server) handleRequestLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := configuredRequestLog()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": p, "exists": p != "" && usableRequestLog() == p})
}
