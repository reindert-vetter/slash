package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// debug_trace.go is the SERVER half of "Debug mode" (see
// .claude/docs/debug-mode.md): while the settings-page switch is on, the server
// appends diagnostic lines to <appDataDir>/debug-server.log, fsync'ed per line
// so the tail survives a SIGKILL ("signal: killed" with no other trace).
//
// Flag: <appDataDir>/debug-server.json ({"on":bool}), loaded at startup
// (TaskManager.SetAppDataDir / runServe) so logging starts BEFORE the UI loads.
// WRITE BOUNDARY: the flag's only writer is saveDebugServerFile, called from the
// app_settings tracker's "saveDebugServer" Activity (Kind "debugMode"). The log
// file itself is purely diagnostic — no read-model, no source of truth, never
// read by the app — so, like run_errors.go's buffer, it is an operational
// carve-out and may be written from anywhere (never from workflow bodies,
// only from Activities/handlers/goroutines).

var (
	debugServerOn  atomic.Bool
	debugTraceMu   sync.Mutex
	debugTraceDir  string
	debugTraceFile *os.File
	debugOnce      sync.Once
)

func debugServerPath(dir string) string { return filepath.Join(dir, "debug-server.json") }

// debugEnabled reports whether server-side debug logging is on.
func debugEnabled() bool { return debugServerOn.Load() }

// loadDebugServerFile applies the stored flag and, when on, starts the
// process-level tracing (signal log + heartbeat). A missing file means off.
func loadDebugServerFile(dir string) {
	on := false
	if raw, err := os.ReadFile(debugServerPath(dir)); err == nil {
		var v struct {
			On bool `json:"on"`
		}
		if json.Unmarshal(raw, &v) == nil {
			on = v.On
		}
	}
	debugTraceMu.Lock()
	debugTraceDir = dir
	debugTraceMu.Unlock()
	setDebugServer(on)
}

func setDebugServer(on bool) {
	debugServerOn.Store(on)
	if on {
		debugOnce.Do(startDebugProcessTrace)
		debugf("debug", "server debug logging ON pid=%d ppid=%d", os.Getpid(), os.Getppid())
	}
}

func saveDebugServerFile(dir string, on bool) error {
	raw, err := json.Marshal(map[string]bool{"on": on})
	if err != nil {
		return err
	}
	tmp := debugServerPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return fmt.Errorf("debug: write temp file: %w", err)
	}
	if err := os.Rename(tmp, debugServerPath(dir)); err != nil {
		return fmt.Errorf("debug: rename temp file: %w", err)
	}
	if !on {
		debugf("debug", "server debug logging OFF")
	}
	debugTraceMu.Lock()
	debugTraceDir = dir
	debugTraceMu.Unlock()
	setDebugServer(on)
	return nil
}

// debugf appends one line and fsyncs it. No-op while debug is off.
func debugf(tag, format string, args ...any) {
	if !debugEnabled() {
		return
	}
	debugTraceMu.Lock()
	defer debugTraceMu.Unlock()
	if debugTraceDir == "" {
		return
	}
	if debugTraceFile == nil {
		f, err := os.OpenFile(filepath.Join(debugTraceDir, "debug-server.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return
		}
		debugTraceFile = f
	}
	line := fmt.Sprintf("%s pid=%d [%s] %s\n", time.Now().Format("2006-01-02T15:04:05.000"), os.Getpid(), tag, fmt.Sprintf(format, args...))
	_, _ = debugTraceFile.WriteString(line)
	_ = debugTraceFile.Sync()
}

// startDebugProcessTrace logs received termination signals (SIGKILL cannot be
// caught: its absence right before the last line is the evidence) and a
// 2-second heartbeat with memory/goroutine numbers.
func startDebugProcessTrace() {
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		for s := range ch {
			debugf("signal", "received %v", s)
			// Re-deliver default behaviour: we only observe, so restore and re-raise.
			signal.Reset(s)
			if p, err := os.FindProcess(os.Getpid()); err == nil {
				_ = p.Signal(s)
			}
		}
	}()
	go func() {
		for range time.Tick(2 * time.Second) {
			if !debugEnabled() {
				continue
			}
			var ms runtime.MemStats
			runtime.ReadMemStats(&ms)
			debugf("heartbeat", "heapMB=%d sysMB=%d goroutines=%d ppid=%d",
				ms.HeapAlloc>>20, ms.Sys>>20, runtime.NumGoroutine(), os.Getppid())
		}
	}()
}

// handleDebugMode serves GET /api/debugmode → {"ok":true,"on":bool}. Pure read.
func (s *server) handleDebugMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "on": debugEnabled()})
}
