package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckPreviousRun(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if msg := checkPreviousRun(dir, 100, now); msg != "" {
		t.Fatalf("first start: unexpected message %q", msg)
	}
	writeRunLock(dir, 100, now, "heap=900MB")
	// Same pid = self_update's syscall.Exec restart, not a kill.
	if msg := checkPreviousRun(dir, 100, now); msg != "" {
		t.Fatalf("same pid: unexpected message %q", msg)
	}
	writeRunLock(dir, 100, now, "heap=900MB")
	msg := checkPreviousRun(dir, 200, now)
	if !strings.Contains(msg, "did not exit cleanly") || !strings.Contains(msg, "heap=900MB") {
		t.Fatalf("unclean exit not reported: %q", msg)
	}
	removeRunLock(dir)
	if msg := checkPreviousRun(dir, 300, now); msg != "" {
		t.Fatalf("after clean exit: unexpected message %q", msg)
	}
}

func TestHeapProfilesRemovedByClear(t *testing.T) {
	dir := t.TempDir()
	if _, err := writeHeapProfile(dir, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := clearDebugLogFile(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, heapProfileDirName)); !os.IsNotExist(err) {
		t.Fatalf("heap profiles still there: %v", err)
	}
}
