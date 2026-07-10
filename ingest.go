package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"time"
)

// ingestMu serializes ingests so concurrent runs don't fight over the worktrees.
var ingestMu sync.Mutex

// ingestResult summarizes an ingest run.
type ingestResult struct {
	PR       int            `json:"pr"`
	Stored   int            `json:"stored"`
	ByStatus map[string]int `json:"byStatus"`
	Warnings []string       `json:"warnings,omitempty"`
}

// worktreeDirs returns absolute base/head worktree paths for a PR under
// data/worktrees. They MUST be absolute: `git -C <repo> worktree add <dir>`
// resolves a relative <dir> against the repo dir, not our CWD.
func worktreeDirs(dataDir string, pr int) (base, head string) {
	root, err := filepath.Abs(dataDir)
	if err != nil {
		root = dataDir
	}
	base = filepath.Join(root, "worktrees", fmt.Sprintf("pr-%d-base", pr))
	head = filepath.Join(root, "worktrees", fmt.Sprintf("pr-%d-head", pr))
	return base, head
}

// ingestPR runs the full pipeline: fetch meta → ensure commits → worktrees →
// diff → parse concurrently → classify → store.
func ingestPR(ctx context.Context, db *sql.DB, dataDir string, pr int) (*ingestResult, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	res := &ingestResult{PR: pr, ByStatus: map[string]int{}}

	meta, err := fetchPRMeta(ctx, pr)
	if err != nil {
		return nil, err
	}
	baseSHA, headSHA := meta.BaseRefOid, meta.HeadRefOid
	if baseSHA == "" || headSHA == "" {
		return nil, fmt.Errorf("pr %d: missing base/head SHA in metadata", pr)
	}
	log.Printf("ingest pr %d: base=%s head=%s files=%d", pr, short(baseSHA), short(headSHA), len(meta.Files))

	if err := ensureCommits(ctx, pr, baseSHA, headSHA); err != nil {
		return nil, err
	}

	baseDir, headDir := worktreeDirs(dataDir, pr)
	if err := ensureWorktree(ctx, baseDir, baseSHA); err != nil {
		return nil, fmt.Errorf("base worktree: %w", err)
	}
	if err := ensureWorktree(ctx, headDir, headSHA); err != nil {
		return nil, fmt.Errorf("head worktree: %w", err)
	}

	paths := make([]string, 0, len(meta.Files))
	for _, f := range meta.Files {
		paths = append(paths, f.Path)
	}

	rawDiff, err := diffBetweenSHAs(ctx, baseSHA, headSHA, paths)
	if err != nil {
		return nil, fmt.Errorf("diff: %w", err)
	}
	diffs := parseUnifiedDiff(rawDiff)

	blocks, perr := parseFiles(pr, paths, baseDir, headDir, diffs)
	for _, e := range perr {
		res.Warnings = append(res.Warnings, e.Error())
		log.Printf("ingest pr %d: parse warning: %v", pr, e)
	}
	if len(blocks) == 0 && len(paths) > 0 {
		return nil, fmt.Errorf("pr %d: parsed zero blocks from %d files", pr, len(paths))
	}

	if err := replacePRBlocks(db, pr, blocks); err != nil {
		return nil, err
	}

	res.Stored = len(blocks)
	for _, b := range blocks {
		res.ByStatus[b.Status]++
	}
	log.Printf("ingest pr %d: stored %d blocks (%v)", pr, res.Stored, res.ByStatus)
	return res, nil
}

// ingestTimeout bounds a full ingest (fetch/worktree/parse).
const ingestTimeout = 5 * time.Minute
