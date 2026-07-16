package main

import "sync"

// Ingest stage keys, set by the Activity bodies in workflows.go (prepareWorktrees,
// scanAndStoreBlocks, buildRelations) and read by GET /api/ingest/progress. Labeled
// client-side in INGEST_STAGE_LABELS (src/overview.mjs).
const (
	IngestStageWorktrees = "worktrees"
	IngestStageScan      = "scan"
	IngestStageRelations = "relations"
)

// ingestProgress tracks, purely in memory, which stage of the ingest pipeline is
// currently running for a PR — cosmetic progress for the "Genereer review-boom"
// button (src/overview.mjs), not durable state: it never touches a
// module/read-model/workflow-history, so it falls outside the
// workflows-write-boundary rule (same carve-out as the heartbeat ping, see
// .claude/rules/workflows-write-boundary.md). Lost on restart — fine, a fresh
// ingest simply starts without a known stage until its first Activity sets one.
var (
	ingestProgressMu   sync.Mutex
	ingestProgressByPR = map[int]string{}
)

// setIngestStage records that pr's ingest pipeline is currently in stage.
func setIngestStage(pr int, stage string) {
	ingestProgressMu.Lock()
	defer ingestProgressMu.Unlock()
	ingestProgressByPR[pr] = stage
}

// clearIngestStage drops pr's current stage (called once its Activity returns,
// success or failure — there's nothing more to report for that step).
func clearIngestStage(pr int) {
	ingestProgressMu.Lock()
	defer ingestProgressMu.Unlock()
	delete(ingestProgressByPR, pr)
}

// ingestStage returns pr's current stage, or "" if none is running.
func ingestStage(pr int) string {
	ingestProgressMu.Lock()
	defer ingestProgressMu.Unlock()
	return ingestProgressByPR[pr]
}
