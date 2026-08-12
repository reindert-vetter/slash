package main

import "testing"

// TestIngestProgress covers the small set/get/clear contract that
// workflows.go's Activity bodies (prepareWorktrees, scanAndStoreBlocks,
// buildRelations) and handleIngestProgress rely on.
func TestIngestProgress(t *testing.T) {
	pr := 999001 // unlikely to collide with any other test's PR number

	if got := ingestStage("", pr); got != "" {
		t.Fatalf("ingestStage(unset) = %q, want empty", got)
	}

	setIngestStage("", pr, IngestStageWorktrees)
	if got := ingestStage("", pr); got != IngestStageWorktrees {
		t.Fatalf("ingestStage after set = %q, want %q", got, IngestStageWorktrees)
	}

	// A later stage overwrites the earlier one for the same PR.
	setIngestStage("", pr, IngestStageScan)
	if got := ingestStage("", pr); got != IngestStageScan {
		t.Fatalf("ingestStage after overwrite = %q, want %q", got, IngestStageScan)
	}

	clearIngestStage("", pr)
	if got := ingestStage("", pr); got != "" {
		t.Fatalf("ingestStage after clear = %q, want empty", got)
	}

	// Different PRs never see each other's stage.
	setIngestStage("", pr, IngestStageRelations)
	if got := ingestStage("", pr+1); got != "" {
		t.Fatalf("ingestStage(other pr) = %q, want empty", got)
	}
	clearIngestStage("", pr)

	// And neither do two repos that happen to share a PR number: the stage map is
	// keyed by (repo, number) — see repos.go.
	setIngestStage("", pr, IngestStageScan)
	setIngestStage("plug-and-pay/plug-and-pay-ops", pr, IngestStageRelations)
	if got := ingestStage("", pr); got != IngestStageScan {
		t.Fatalf("primary repo stage = %q, want %q", got, IngestStageScan)
	}
	if got := ingestStage("plug-and-pay/plug-and-pay-ops", pr); got != IngestStageRelations {
		t.Fatalf("second repo stage = %q, want %q", got, IngestStageRelations)
	}
	clearIngestStage("", pr)
	if got := ingestStage("plug-and-pay/plug-and-pay-ops", pr); got != IngestStageRelations {
		t.Fatalf("clearing one repo must not clear the other, got %q", got)
	}
	clearIngestStage("plug-and-pay/plug-and-pay-ops", pr)
}
