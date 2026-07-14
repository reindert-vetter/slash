package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/github"
)

// The approvals module round-trips a block's approved rows + call segments, and
// Replace is a full swap per block (an empty set clears the row).
func TestApprovalsModuleRoundTrip(t *testing.T) {
	m, err := approvals.Open(filepath.Join(t.TempDir(), "approvals.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if err := m.Replace(ctx, 1, "1:a.php:A::x", []int{2, 5, 7}, []string{"5:10"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Replace(ctx, 1, "1:b.php:B::y", []int{3}, nil); err != nil {
		t.Fatal(err)
	}
	got, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("List = %d rows, want 2", len(got))
	}
	// Ordered by block_id: A::x first.
	if got[0].BlockID != "1:a.php:A::x" || len(got[0].Rows) != 3 || len(got[0].Calls) != 1 {
		t.Fatalf("row 0 = %+v, want A::x with 3 rows + 1 call", got[0])
	}
	if got[0].Calls[0] != "5:10" {
		t.Fatalf("call seg = %q, want 5:10", got[0].Calls[0])
	}

	// Full swap: re-approving A::x with a smaller set overwrites the larger one.
	if err := m.Replace(ctx, 1, "1:a.php:A::x", []int{2}, nil); err != nil {
		t.Fatal(err)
	}
	got, _ = m.List(ctx, 1)
	var a *approvals.Approval
	for i := range got {
		if got[i].BlockID == "1:a.php:A::x" {
			a = &got[i]
		}
	}
	if a == nil || len(a.Rows) != 1 || len(a.Calls) != 0 {
		t.Fatalf("after shrink A::x = %+v, want 1 row + 0 calls", a)
	}

	// An empty set clears the block's row entirely.
	if err := m.Replace(ctx, 1, "1:a.php:A::x", nil, nil); err != nil {
		t.Fatal(err)
	}
	got, _ = m.List(ctx, 1)
	if len(got) != 1 || got[0].BlockID != "1:b.php:B::y" {
		t.Fatalf("after clear List = %+v, want only B::y", got)
	}

	// A different PR is untouched by another PR's writes.
	if got, _ := m.List(ctx, 2); len(got) != 0 {
		t.Fatalf("other PR List = %d rows, want 0", len(got))
	}
}

// The approve workflow end-to-end: EnsureApprovals starts the per-PR tracker, a
// "set" Signal drives the saveApproval Activity, and the state lands in the
// read-model. A follow-up "set" for the same block full-swaps it.
func TestApproveWorkflow(t *testing.T) {
	ap, err := approvals.Open(filepath.Join(t.TempDir(), "approvals.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ap.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, ap, nil, nil, nil, "", "test/repo")

	ctx := context.Background()
	pr := 42
	runID, err := m.EnsureApprovals(pr)
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("EnsureApprovals returned empty run ID")
	}

	if err := engine.SignalWorkflow(runID, SignalSet, ApprovalSignal{
		BlockID: "42:a.php:A::x", Rows: []int{1, 4}, Calls: []string{"4:8"},
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ap.List(ctx, pr)
		return len(got) == 1 && len(got[0].Rows) == 2 && len(got[0].Calls) == 1
	})

	// A second set for the same block full-swaps it (fewer rows, no calls).
	if err := engine.SignalWorkflow(runID, SignalSet, ApprovalSignal{
		BlockID: "42:a.php:A::x", Rows: []int{1}, Calls: nil,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := ap.List(ctx, pr)
		return len(got) == 1 && len(got[0].Rows) == 1 && len(got[0].Calls) == 0
	})

	// EnsureApprovals is idempotent: a second call reuses the same Execution.
	again, err := m.EnsureApprovals(pr)
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("EnsureApprovals returned a new run ID %q, want reuse of %q", again, runID)
	}
}

// A "set" Signal carrying a Viewed request (rather than a BlockID) drives the
// setFileViewed Activity instead of saveApproval — it marks/unmarks the file's
// GitHub "Viewed" checkbox via github.Client, and never touches the approvals
// read-model.
func TestApproveWorkflowFileViewed(t *testing.T) {
	ap, err := approvals.Open(filepath.Join(t.TempDir(), "approvals.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ap.Close()

	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, ap, nil, nil, nil, "", "test/repo")

	pr := 43
	runID, err := m.EnsureApprovals(pr)
	if err != nil {
		t.Fatal(err)
	}

	viewedTrue := true
	if err := engine.SignalWorkflow(runID, SignalSet, ApprovalSignal{
		File: "app/Foo.php", Viewed: &viewedTrue,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.IsViewed(pr, "app/Foo.php") })

	viewedFalse := false
	if err := engine.SignalWorkflow(runID, SignalSet, ApprovalSignal{
		File: "app/Foo.php", Viewed: &viewedFalse,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !gh.IsViewed(pr, "app/Foo.php") })

	// The approvals read-model was never touched by the viewed requests.
	if got, _ := ap.List(context.Background(), pr); len(got) != 0 {
		t.Fatalf("approvals List = %+v, want none (viewed-only signals)", got)
	}
}
