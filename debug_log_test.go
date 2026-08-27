package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDebugLogAppendAndClear covers the whole file contract in one pass: an
// append creates the file, a second append (a second session) keeps the first
// one's lines, every line is one self-contained JSON object carrying its
// session, and a clear empties it without removing it.
func TestDebugLogAppendAndClear(t *testing.T) {
	dir := t.TempDir()
	if _, err := appendDebugLogFile(dir, DebugLogInput{
		Kind:    "append",
		Session: "s1",
		Page:    "/pr/12112",
		Events: []DebugLogEvent{
			{T: 1, Type: "session", URL: "http://x/pr/12112?sel=a.php:10"},
			{T: 2, Type: "key", Key: "ArrowDown"},
		},
	}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := appendDebugLogFile(dir, DebugLogInput{
		Kind:    "append",
		Session: "s2",
		Page:    "/pr-overview",
		Events:  []DebugLogEvent{{T: 3, Type: "click", Target: "pr-row"}},
	}); err != nil {
		t.Fatalf("second append: %v", err)
	}

	lines, total, err := readDebugLogTail(dir, 0)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if total != 3 || len(lines) != 3 {
		t.Fatalf("want 3 lines, got total=%d len=%d", total, len(lines))
	}
	var first debugLogRecord
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("line 0 is not one JSON object: %v", err)
	}
	if first.Type != "session" || first.Session != "s1" || !strings.Contains(first.URL, "sel=a.php:10") {
		t.Fatalf("first line lost its session/url: %+v", first)
	}
	if first.At == "" {
		t.Fatalf("no server timestamp on %+v", first)
	}
	var last debugLogRecord
	if err := json.Unmarshal([]byte(lines[2]), &last); err != nil {
		t.Fatalf("line 2: %v", err)
	}
	if last.Session != "s2" || last.Page != "/pr-overview" {
		t.Fatalf("second session's line is wrong: %+v", last)
	}

	// The tail read is a tail, not the whole file.
	tail, total, err := readDebugLogTail(dir, 1)
	if err != nil || total != 3 || len(tail) != 1 || !strings.Contains(tail[0], "pr-row") {
		t.Fatalf("tail read wrong: %v total=%d tail=%v", err, total, tail)
	}

	if err := clearDebugLogFile(dir); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, total, _ := readDebugLogTail(dir, 0); total != 0 {
		t.Fatalf("clear left %d lines", total)
	}
	if _, err := os.Stat(filepath.Join(dir, debugLogFileName)); err != nil {
		t.Fatalf("clear should truncate, not remove: %v", err)
	}
}

// TestDebugLogTrimKeepsNewest checks the size bound: once the file is over the
// byte cap, the next append rewrites it keeping only the newest lines — and the
// newest event is still the last line afterwards.
func TestDebugLogTrimKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	path := debugLogPath(dir)
	// One oversized file, cheaply: debugLogMaxBytes of filler lines.
	var b strings.Builder
	for b.Len() <= debugLogMaxBytes {
		b.WriteString(`{"at":"x","type":"key","key":"ArrowDown"}` + "\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	before, _, _ := readDebugLogTail(dir, 0)
	if _, err := appendDebugLogFile(dir, DebugLogInput{
		Kind:   "append",
		Events: []DebugLogEvent{{Type: "action", Key: "command", Detail: "keep-me"}},
	}); err != nil {
		t.Fatalf("append: %v", err)
	}
	lines, total, err := readDebugLogTail(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != debugLogKeepLines {
		t.Fatalf("want trimmed to %d lines, got %d (was %d)", debugLogKeepLines, total, len(before))
	}
	if !strings.Contains(lines[len(lines)-1], "keep-me") {
		t.Fatalf("trim dropped the newest event: %q", lines[len(lines)-1])
	}
	if st, err := os.Stat(path); err != nil || st.Size() > debugLogMaxBytes {
		t.Fatalf("still over cap after trim: %v", err)
	}
}

// TestValidateDebugLogInput guards the door: an unknown kind or event type, an
// empty or oversized batch, is rejected before an Execution is started, and an
// over-long field is truncated rather than fatal.
func TestValidateDebugLogInput(t *testing.T) {
	if err := validateDebugLogInput(&DebugLogInput{Kind: "nonsense"}); err == nil {
		t.Fatal("unknown kind accepted")
	}
	if err := validateDebugLogInput(&DebugLogInput{Kind: "append"}); err == nil {
		t.Fatal("empty batch accepted")
	}
	if err := validateDebugLogInput(&DebugLogInput{
		Kind:   "append",
		Events: []DebugLogEvent{{Type: "whatever"}},
	}); err == nil {
		t.Fatal("unknown event type accepted")
	}
	big := make([]DebugLogEvent, debugLogMaxBatch+1)
	for i := range big {
		big[i] = DebugLogEvent{Type: "key", Key: "x"}
	}
	if err := validateDebugLogInput(&DebugLogInput{Kind: "append", Events: big}); err == nil {
		t.Fatal("oversized batch accepted")
	}

	long := strings.Repeat("a", debugLogMaxField*2)
	in := DebugLogInput{Kind: "append", Events: []DebugLogEvent{{Type: "nav", URL: long, Detail: "one\ntwo"}}}
	if err := validateDebugLogInput(&in); err != nil {
		t.Fatalf("valid batch rejected: %v", err)
	}
	if len(in.Events[0].URL) > debugLogMaxField+4 {
		t.Fatalf("url not truncated: %d", len(in.Events[0].URL))
	}
	if strings.Contains(in.Events[0].Detail, "\n") {
		t.Fatalf("newline survived into a one-line-per-event file: %q", in.Events[0].Detail)
	}

	// A clear carries no events, and any that were sent are dropped.
	clear := DebugLogInput{Kind: "clear", Events: []DebugLogEvent{{Type: "key"}}}
	if err := validateDebugLogInput(&clear); err != nil || clear.Events != nil {
		t.Fatalf("clear normalization wrong: %v %+v", err, clear.Events)
	}
}
