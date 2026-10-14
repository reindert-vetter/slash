package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDebugTraceWritesOnlyWhenOn(t *testing.T) {
	dir := t.TempDir()
	loadDebugServerFile(dir) // no file => off
	debugf("t", "hidden")
	if _, err := os.Stat(filepath.Join(dir, "debug-server.log")); err == nil {
		t.Fatal("log written while debug is off")
	}
	if err := saveDebugServerFile(dir, true); err != nil {
		t.Fatal(err)
	}
	debugf("t", "visible %d", 1)
	raw, _ := os.ReadFile(filepath.Join(dir, "debug-server.log"))
	if !strings.Contains(string(raw), "visible 1") || strings.Contains(string(raw), "hidden") {
		t.Fatalf("unexpected log: %q", raw)
	}
	// persisted: a fresh load picks the flag up again
	debugServerOn.Store(false)
	loadDebugServerFile(dir)
	if !debugEnabled() {
		t.Fatal("flag not restored from file")
	}
	_ = saveDebugServerFile(dir, false)
	debugTraceMu.Lock()
	if debugTraceFile != nil {
		debugTraceFile.Close()
		debugTraceFile = nil
	}
	debugTraceMu.Unlock()
}
