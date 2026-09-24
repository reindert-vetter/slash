package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
)

// TestPRSummaryRetriedAndRegeneratedOnEdit pins the pr_status stage-2 refresh:
// a summary whose one-shot generation at tracker start failed used to stay
// empty forever (the review tree showed "samenvatting genereren…" on every
// open), and an edited title/description never reached it. Now the page-load
// state signal carries RefreshSummary exactly when the summary is empty or
// its source changed — and never when it is still current.
func TestPRSummaryRetriedAndRegeneratedOnEdit(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off")
	ctx := context.Background()
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	gh.SetPRMeta(github.Meta{Title: "fix the thing", Body: "v1"})
	cl := claude.NewFake()
	cl.SetError(claude.ModelHaiku, errors.New("timeout"))
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, cl, nil, nil, "", "test/repo")

	runID, err := m.EnsurePRStatus("", 7)
	if err != nil {
		t.Fatal(err)
	}
	engine.Wait()
	summary := func() string {
		t.Helper()
		meta, _, err := pm.Get(ctx, "", 7)
		if err != nil {
			t.Fatal(err)
		}
		return meta.Summary
	}
	// signal mirrors handleWorkflowSignal's page-load state signal.
	signal := func() {
		t.Helper()
		sig := PRStateSignal{RefreshSince: true, RefreshSummary: m.prSummaryRefreshNeeded(ctx, runID)}
		if err := engine.SignalWorkflow(runID, SignalPRState, sig); err != nil {
			t.Fatal(err)
		}
		engine.Wait()
	}
	if got := summary(); got != "" {
		t.Fatalf("summary after failed start = %q, want empty", got)
	}

	// Empty → retried on the next page load.
	cl.SetError(claude.ModelHaiku, nil)
	cl.SetOutput(claude.ModelHaiku, "first summary")
	signal()
	if got := summary(); got != "first summary" {
		t.Fatalf("summary after retry = %q, want %q", got, "first summary")
	}

	// Unchanged title/body → never regenerated.
	calls := cl.CallCount()
	if m.prSummaryRefreshNeeded(ctx, runID) {
		t.Fatal("refresh needed for a current summary")
	}
	cl.SetOutput(claude.ModelHaiku, "second summary")
	signal()
	if got := summary(); got != "first summary" || cl.CallCount() != calls {
		t.Fatalf("current summary regenerated: %q (calls %d → %d)", got, calls, cl.CallCount())
	}

	// Edited description → regenerated.
	gh.SetPRMeta(github.Meta{Title: "fix the thing", Body: "v2"})
	signal()
	if got := summary(); got != "second summary" {
		t.Fatalf("summary after body edit = %q, want %q", got, "second summary")
	}
}
