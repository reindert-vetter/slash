package main

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
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

	res, err := m.StartIngest(context.Background(), "", pr)
	if err != nil {
		t.Fatalf("StartIngest: %v", err)
	}
	if res.Stored == 0 {
		t.Fatalf("ingest stored 0 blocks: %+v", res)
	}

	blocks, err := blocksByPR(db, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != res.Stored {
		t.Fatalf("db has %d blocks, StartIngest reported %d", len(blocks), res.Stored)
	}
}

// TestStartIngestSurfacesRealFailure asserts StartIngest's error carries the
// actual recorded failure (the ActivityFailed/WorkflowFailed text), not just a
// bare "ingest failed (run ...)" the reviewer would have to look up in the
// workflow history themselves. Overrides the registered "ingest" workflow
// with a stub that fails immediately, so this needs no gh/git access.
func TestStartIngestSurfacesRealFailure(t *testing.T) {
	dataDir := t.TempDir()
	pr := 999999

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, db, dataDir, repoSlug)

	const wantCause = "git@github.com: Permission denied (publickey)"
	engine.RegisterWorkflow(WorkflowIngest, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, fmt.Errorf("prepare worktrees: ingest: prepare worktrees: cannot fetch commit bb4fd705: %s", wantCause)
	})

	_, err = m.StartIngest(context.Background(), "", pr)
	if err == nil {
		t.Fatal("expected StartIngest to fail")
	}
	if !strings.Contains(err.Error(), wantCause) {
		t.Fatalf("StartIngest error does not surface the real cause: %v", err)
	}
}

// TestStartIngestFriendlyMessageForAuthFailure asserts a git-auth failure
// (a rejected SSH key) gets a friendly, actionable line ON TOP of the raw
// technical text — not instead of it, see ingestFailureError. Same stub
// approach as TestStartIngestSurfacesRealFailure above.
func TestStartIngestFriendlyMessageForAuthFailure(t *testing.T) {
	dataDir := t.TempDir()
	pr := 999998

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, db, dataDir, repoSlug)

	const wantCause = "git@github.com: Permission denied (publickey). fatal: Could not read from remote repository."
	engine.RegisterWorkflow(WorkflowIngest, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return nil, fmt.Errorf("prepare worktrees: ingest: prepare worktrees: cannot fetch commit fa183319: exit status 128: %s", wantCause)
	})

	_, err = m.StartIngest(context.Background(), "", pr)
	if err == nil {
		t.Fatal("expected StartIngest to fail")
	}
	const wantFriendly = "We kunnen geen `git pull` draaien. Doe dit handmatig in de terminal en typ je wachtwoord."
	if !strings.Contains(err.Error(), wantFriendly) {
		t.Fatalf("StartIngest error is missing the friendly message: %v", err)
	}
	if !strings.Contains(err.Error(), wantCause) {
		t.Fatalf("StartIngest error dropped the real cause: %v", err)
	}
}

// TestIngestEnsuresPRStatus asserts that handleIngest's (and the `slash
// ingest` CLI's) own follow-up sequence — StartIngest, then EnsureRelations,
// then EnsurePRStatus — actually creates the pr_status tracker, so an ingest
// triggered purely via the API/CLI (no browser tab ever opened on the PR)
// still gets the PR summary/CI status AND the ingest-refresh/comment-import
// pollers pr_status spawns for a genuinely new run (see ensurePRStatus). The
// ingest workflow itself is stubbed (no gh/git access needed, mirrors
// TestStartIngestSurfacesRealFailure); EnsureRelations then runs against the
// (empty) blocks table, which is enough for its own Activity to complete.
func TestIngestEnsuresPRStatus(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off") // fetchPRStatuses shells to gh directly; keep this test offline
	dataDir := t.TempDir()
	pr := 999998

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	gh := &github.Fake{}
	gh.SetPRMeta(github.Meta{Title: "PS-999 stub", URL: "https://github.com/x/y/pull/999998"})
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, db, dataDir, repoSlug)
	engine.RegisterWorkflow(WorkflowIngest, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		return []byte(`{"stored":0}`), nil
	})

	ctx := context.Background()
	if _, err := m.StartIngest(ctx, "", pr); err != nil {
		t.Fatalf("StartIngest: %v", err)
	}
	m.EnsureRelations(ctx, "", pr)
	if _, err := m.EnsurePRStatus("", pr); err != nil {
		t.Fatalf("EnsurePRStatus: %v", err)
	}

	if id := m.findPRStatusLocked("", pr); id == "" {
		t.Fatal("no pr_status tracker found for pr after ingest")
	}
}
