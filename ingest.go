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

// worktreeSHAs is the small summary prepareWorktrees returns — the two SHAs
// plus the PR's changed file paths, so this step's Activity result stays
// compact in the workflow history (the worktrees themselves live on disk at
// their deterministic paths, see worktreeDirs) while sparing the second step a
// redundant gh fetch.
type worktreeSHAs struct {
	BaseSHA string   `json:"baseSHA"`
	HeadSHA string   `json:"headSHA"`
	Paths   []string `json:"paths"`
}

// prepareIngestWorktrees fetches the PR's metadata, ensures both commits are
// locally reachable, and materializes the base/head worktrees. This is the
// side-effecting first step of the ingest pipeline (network + git), run as the
// ingest workflow's "prepareWorktrees" Activity.
func prepareIngestWorktrees(ctx context.Context, dataDir string, pr int) (worktreeSHAs, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	meta, err := fetchPRMeta(ctx, pr)
	if err != nil {
		return worktreeSHAs{}, err
	}
	baseSHA, headSHA := meta.BaseRefOid, meta.HeadRefOid
	if baseSHA == "" || headSHA == "" {
		return worktreeSHAs{}, fmt.Errorf("pr %d: missing base/head SHA in metadata", pr)
	}
	log.Printf("ingest pr %d: base=%s head=%s files=%d", pr, short(baseSHA), short(headSHA), len(meta.Files))

	if err := ensureCommits(ctx, pr, baseSHA, headSHA); err != nil {
		return worktreeSHAs{}, err
	}

	baseDir, headDir := worktreeDirs(dataDir, pr)
	if err := ensureWorktree(ctx, baseDir, baseSHA); err != nil {
		return worktreeSHAs{}, fmt.Errorf("base worktree: %w", err)
	}
	if err := ensureWorktree(ctx, headDir, headSHA); err != nil {
		return worktreeSHAs{}, fmt.Errorf("head worktree: %w", err)
	}

	paths := make([]string, 0, len(meta.Files))
	for _, f := range meta.Files {
		paths = append(paths, f.Path)
	}
	return worktreeSHAs{BaseSHA: baseSHA, HeadSHA: headSHA, Paths: paths}, nil
}

// scanAndStoreIngestBlocks diffs the two worktrees, parses+classifies the
// touched PHP files, and full-swaps the resulting blocks into the DB. This is
// the side-effecting second step of the ingest pipeline (git diff + file reads
// + DB write), run as the ingest workflow's "scanAndStoreBlocks" Activity.
func scanAndStoreIngestBlocks(ctx context.Context, db *sql.DB, dataDir string, pr int, shas worktreeSHAs) (*ingestResult, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	res := &ingestResult{PR: pr, ByStatus: map[string]int{}}

	baseDir, headDir := worktreeDirs(dataDir, pr)
	paths := shas.Paths

	rawDiff, err := diffBetweenSHAs(ctx, shas.BaseSHA, shas.HeadSHA, paths)
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
