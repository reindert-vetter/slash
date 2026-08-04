package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
)

// TestWaitReadyBlocksUntilMarkReady asserts the gate mechanics themselves:
// after ArmReadyGate, a goroutine parked in waitReady must not proceed until
// MarkReady is called — the primitive behind every background poller/trigger
// gated on server startup (see workflows.go's ArmReadyGate/MarkReady/waitReady
// doc comments).
func TestWaitReadyBlocksUntilMarkReady(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, nil, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.ArmReadyGate()

	proceeded := make(chan struct{})
	go func() {
		m.waitReady()
		close(proceeded)
	}()

	select {
	case <-proceeded:
		t.Fatal("waitReady returned before MarkReady was called")
	case <-time.After(50 * time.Millisecond):
	}

	m.MarkReady()

	select {
	case <-proceeded:
	case <-time.After(2 * time.Second):
		t.Fatal("waitReady never returned after MarkReady")
	}
}

// TestWaitReadyIsNoOpWithoutArm asserts the default (never armed) case every
// existing test/CLI caller relies on: waitReady returns immediately when
// ArmReadyGate was never called.
func TestWaitReadyIsNoOpWithoutArm(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, nil, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	done := make(chan struct{})
	go func() {
		m.waitReady()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("waitReady blocked despite ArmReadyGate never being called")
	}
}

// TestAutoStartCodeWarningWaitsForReadyGate asserts the automatic code_warning
// trigger — queued via enqueueAutoStartCodeWarning, same path the
// autoStartCodeWarning Activity uses — does not start its workflow while the
// ready gate is closed, and does start once MarkReady opens it. This is the
// concrete regression covered by the "server takes 5 minutes to bind instead
// of ~50s" report: a burst of automatic triggers during startup recovery must
// never run ahead of the HTTP listener binding.
func TestAutoStartCodeWarningWaitsForReadyGate(t *testing.T) {
	dataDir := t.TempDir()
	pr := 90
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())
	m.ArmReadyGate()

	m.enqueueAutoStartCodeWarning(pr)

	// Give the (lazily started) worker every chance to misbehave before
	// asserting it did not.
	time.Sleep(100 * time.Millisecond)
	if codeWarningRunExistsNow(m, pr) {
		t.Fatal("code_warning run started before the ready gate opened")
	}

	m.MarkReady()

	if !codeWarningRunExists(t, m, pr) {
		t.Fatal("code_warning run never started after the ready gate opened")
	}
}

// TestAutoStartCodeWarningSerializesMultiplePRs asserts a burst of automatic
// triggers queued while the gate is closed — the exact "many PRs got new
// commits while the server was down" scenario — all eventually run once the
// gate opens, through the single serial worker (no goroutine-per-trigger
// thundering herd).
func TestAutoStartCodeWarningSerializesMultiplePRs(t *testing.T) {
	dataDir := t.TempDir()
	prs := []int{91, 92, 93}
	db := mustOpenGraphDB(t, dataDir)
	for _, pr := range prs {
		writeWarningFixtureRepo(t, dataDir, pr)
		if err := replacePRBlocks(db, pr, []Block{warningFixtureBlock(pr)}); err != nil {
			t.Fatal(err)
		}
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())
	m.ArmReadyGate()

	for _, pr := range prs {
		m.enqueueAutoStartCodeWarning(pr)
	}
	m.MarkReady()

	for _, pr := range prs {
		if !codeWarningRunExists(t, m, pr) {
			t.Fatalf("code_warning run for pr=%d never started", pr)
		}
	}
}

// codeWarningRunExistsNow is codeWarningRunExists without the polling
// wait — a single, immediate check, for asserting a negative ("has NOT
// started yet") where polling for up to 2s would defeat the purpose.
func codeWarningRunExistsNow(m *TaskManager, pr int) bool {
	runs, err := m.engine.Runs()
	if err != nil {
		return false
	}
	for _, r := range runs {
		if r.Workflow != WorkflowCodeWarning {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin CodeWarningInput
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr {
			return true
		}
	}
	return false
}
