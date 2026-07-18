package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
)

// TestIngestWorkflowEndToEnd runs the ingest workflow (prepareWorktrees →
// scanAndStoreBlocks) against a real PR and asserts the blocks land in the DB
// — this is the write-boundary fix under test: block/worktree writes now only
// happen inside these two Activities, driven by StartIngest. It needs real
// gh/git access (fetchPRMeta/ensureCommits/ensureWorktree/diffBetweenSHAs have
// no offline fake, unlike the github/claude/jira modules), so it skips itself
// when gh isn't reachable rather than flaking CI.
func TestIngestWorkflowEndToEnd(t *testing.T) {
	if _, err := exec.Command("gh", "pr", "view", "12903", "--repo", repoSlug, "--json", "number").Output(); err != nil {
		t.Skipf("gh not reachable, skipping: %v", err)
	}

	dataDir := t.TempDir()
	pr := 12903

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, db, dataDir, repoSlug)

	res, err := m.StartIngest(context.Background(), pr)
	if err != nil {
		t.Fatalf("StartIngest: %v", err)
	}
	if res.Stored == 0 {
		t.Fatalf("ingest stored 0 blocks: %+v", res)
	}

	blocks, err := blocksByPR(db, pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != res.Stored {
		t.Fatalf("db has %d blocks, StartIngest reported %d", len(blocks), res.Stored)
	}
}
