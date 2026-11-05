package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"slash/modules/claude"
)

func writeQATestFile(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestQARunSinkWritesADurableCheckpoint: a finished step carries its finding
// and the screenshots made while it ran, and every marker batch lands in
// <runDir>/checkpoint.json.
func TestQARunSinkWritesADurableCheckpoint(t *testing.T) {
	const repo, pr, runID = "test/qa-checkpoint", 991101, "aaaaaaaaaaaaaaaaaaaaaaaa"
	runDir := t.TempDir()
	arg := qaRunArg{QARunInput: QARunInput{Repo: repo, PR: pr, Round: 1}, RunID: runID}
	startQARunProgress(repo, pr, runID)
	sink := qaRunProgressSink(repo, pr, runDir, func() { saveCheckpointNow(arg, runDir, "abc123") })
	text := func(s string) { sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: s}) }

	text("[slash:qa-plan] Verwijderen opschonen\n[slash:qa-todo] 1 | Opzet\n[slash:qa-todo] 2 | Verwijderen\n[slash:qa-todo] 3 | Bevindingen\n[slash:qa-doing] 1\n")
	writeQATestFile(t, runDir, "r1-01-login.png")
	writeQATestFile(t, runDir, "r1-02-lijst.png")
	text("[slash:qa-done] 1 ok | Twee inzendingen (20, 21) met conversies in ClickHouse\n[slash:qa-doing] 2\n")
	writeQATestFile(t, runDir, "r1-03-na.png")
	text("[slash:qa-doing] 3\n") // 2 auto-done: still gets its screenshot

	cp, ok := loadQACheckpoint(runDir)
	if !ok {
		t.Fatal("no checkpoint written")
	}
	if cp.RunID != runID || cp.Head != "abc123" || cp.Plan != "Verwijderen opschonen" || len(cp.Todos) != 3 {
		t.Fatalf("checkpoint = %+v", cp)
	}
	one, two := cp.Todos[0], cp.Todos[1]
	if one.State != "done" || one.Result != "ok" || one.Finding != "Twee inzendingen (20, 21) met conversies in ClickHouse" {
		t.Fatalf("step 1 = %+v", one)
	}
	if !eqStrings(one.Images, []string{"r1-01-login.png", "r1-02-lijst.png"}) || !eqStrings(two.Images, []string{"r1-03-na.png"}) {
		t.Fatalf("images: 1=%v 2=%v", one.Images, two.Images)
	}
	if cp.Todos[2].State != "doing" {
		t.Fatalf("step 3 = %+v", cp.Todos[2])
	}
}

// TestQAResumeAfterRestart: the run's own checkpoint seeds the checklist (the
// interrupted step is open again) and the prompt lists the finished steps
// instead of asking for a fresh plan; a moved HEAD is named.
func TestQAResumeAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	arg := qaRunArg{QARunInput: QARunInput{PR: 14561, Round: 2}, RunID: "bbbbbbbbbbbbbbbbbbbbbbbb"}
	runDir := qaRunDir(dataDir, arg.PR, arg.RunID)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := saveQACheckpoint(runDir, qaCheckpoint{RunID: arg.RunID, Head: "d31b43b3386aaaa", Plan: "plan", Todos: []qaTodo{
		{ID: "1", Title: "Opzet", State: "done", Result: "ok", Finding: "data klaar", Images: []string{"r2-01.png"}},
		{ID: "2", Title: "Verwijderen", State: "doing"},
		{ID: "3", Title: "Bevindingen", State: "todo"},
	}}); err != nil {
		t.Fatal(err)
	}
	r := qaResumeFor(dataDir, arg, runDir, "b304d7375cfbbbb", false)
	if r == nil || r.FromRound != 0 {
		t.Fatalf("resume = %+v", r)
	}
	p := &qaRunProgress{}
	seedQAResume(p, r)
	if got := qaTodoSummary(*p); !eqStrings(got, []string{"1:done:ok", "2:todo", "3:todo"}) {
		t.Fatalf("seeded = %v", got)
	}
	prompt := qaRunPrompt(arg, runDir, nil, r)
	for _, want := range []string{"HERVATTING", "1 · klaar, ok · Opzet — data klaar [r2-01.png]", "2 · onderbroken, opnieuw doen", "git log --oneline d31b43b3386aaaa..b304d7375cfbbbb", "NIET opnieuw"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt misses %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "Begin met het afleiden") {
		t.Fatal("a resumed prompt must not ask for a fresh start")
	}
	devs := qaResumeDeviation(r)
	if len(devs) != 2 || !strings.Contains(devs[0], "herstart") || !strings.Contains(devs[1], "d31b43b3386 → b304d7375cf") {
		t.Fatalf("deviations = %v", devs)
	}
}

// TestQAResumeFromAReportlessRound: a new round continues the previous round's
// steps only when that round left no report, and copies its screenshots.
func TestQAResumeFromAReportlessRound(t *testing.T) {
	dataDir := t.TempDir()
	prevID := "cccccccccccccccccccccccc"
	prevDir := qaRunDir(dataDir, 14561, prevID)
	if err := os.MkdirAll(prevDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeQATestFile(t, prevDir, "r1-01-login.png")
	if err := saveQACheckpoint(prevDir, qaCheckpoint{RunID: prevID, Head: "same", Todos: []qaTodo{
		{ID: "1", Title: "Opzet", State: "done", Result: "ok", Images: []string{"r1-01-login.png", "../evil.png"}},
	}}); err != nil {
		t.Fatal(err)
	}
	arg := qaRunArg{QARunInput: QARunInput{PR: 14561, Round: 2, PrevRunID: prevID}, RunID: "dddddddddddddddddddddddd"}
	runDir := qaRunDir(dataDir, arg.PR, arg.RunID)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if r := qaResumeFor(dataDir, arg, runDir, "same", true); r != nil {
		t.Fatalf("a round WITH a report must not be resumed: %+v", r)
	}
	r := qaResumeFor(dataDir, arg, runDir, "same", false)
	if r == nil || r.FromRound != 1 {
		t.Fatalf("resume = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(runDir, "r1-01-login.png")); err != nil {
		t.Fatal("screenshot not copied into the new round's dir")
	}
	if devs := qaResumeDeviation(r); len(devs) != 1 || !strings.Contains(devs[0], "ronde 1") {
		t.Fatalf("deviations = %v", devs)
	}
	if !strings.Contains(qaRunPrompt(arg, runDir, nil, r), "ronde 1 stopte zonder verslag") {
		t.Fatal("prompt misses the round resume line")
	}
}

// TestQASnapshotRoundTrip: the checkout guard's snapshot survives a restart
// byte for byte.
func TestQASnapshotRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, ok := loadQASnapshot(dir); ok {
		t.Fatal("no snapshot yet")
	}
	in := &qaCheckoutSnapshot{Head: "abc", Dirty: map[string]string{"a.txt": " M", "new/": "??"}, Content: map[string][]byte{"a.txt": {0, 1, 'x'}}}
	if err := saveQASnapshot(dir, in); err != nil {
		t.Fatal(err)
	}
	out, ok := loadQASnapshot(dir)
	if !ok || out.Head != "abc" || out.Dirty["new/"] != "??" || string(out.Content["a.txt"]) != string([]byte{0, 1, 'x'}) {
		t.Fatalf("round trip = %+v", out)
	}
}
