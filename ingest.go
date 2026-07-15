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
	// Skipped is true when an ingest-refresh found nothing new (head SHA
	// unchanged) — only meaningful on the refreshIngestDelta path, never set by
	// a full ingest.
	Skipped bool `json:"skipped,omitempty"`
	// FullFallback is true when a refresh had to fall back to the full ingest
	// pipeline because the PR's base SHA moved (e.g. rebased onto a newer
	// develop) — an incremental diff against the old base would be unsound.
	FullFallback bool `json:"fullFallback,omitempty"`
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
	return prepareIngestWorktreesLocked(ctx, dataDir, pr)
}

// prepareIngestWorktreesLocked is prepareIngestWorktrees's body, extracted so
// refreshIngestDelta (which already holds ingestMu) can fall back to a full
// ingest without re-locking a non-reentrant mutex.
func prepareIngestWorktreesLocked(ctx context.Context, dataDir string, pr int) (worktreeSHAs, error) {
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
	return scanAndStoreIngestBlocksLocked(ctx, db, dataDir, pr, shas)
}

// scanAndStoreIngestBlocksLocked is scanAndStoreIngestBlocks's body, extracted
// so refreshIngestDelta (which already holds ingestMu) can fall back to a full
// ingest without re-locking a non-reentrant mutex.
func scanAndStoreIngestBlocksLocked(ctx context.Context, db *sql.DB, dataDir string, pr int, shas worktreeSHAs) (*ingestResult, error) {
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
	// Record the SHAs this full ingest populated the blocks table from, so a
	// later refreshIngestDelta knows exactly which head SHA to diff from.
	if err := saveIngestSHAs(db, pr, shas.BaseSHA, shas.HeadSHA); err != nil {
		return nil, fmt.Errorf("save ingest shas: %w", err)
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

// refreshIngestDelta incrementally refreshes a PR's blocks after new commits
// landed on its head ref: it diffs the previously-ingested head SHA against
// the newly observed one, re-parses+upserts only the files that changed in
// that delta (via upsertPRFileBlocks — every other file's blocks, and
// anything keyed off a block id in the separate comments/approvals/
// callresolve read-models, are left completely untouched), and records the
// new SHAs. If the PR's base SHA itself changed (e.g. a rebase onto a newer
// develop) an incremental diff against the old base would be unsound, so it
// falls back to the full ingest pipeline instead (prepareIngestWorktrees +
// scanAndStoreIngestBlocks — the very same full per-PR swap a manual
// `POST /api/ingest` performs). This is the ingest workflow's
// "refreshIngestDelta" Activity, driven by pr_status's SignalPRState branch.
func refreshIngestDelta(ctx context.Context, db *sql.DB, dataDir string, pr int, baseSHA, headSHA string) (*ingestResult, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	prevBase, prevHead, ok, err := loadIngestSHAs(db, pr)
	if err != nil {
		return nil, fmt.Errorf("load ingest state: %w", err)
	}
	if !ok {
		return nil, fmt.Errorf("pr %d: no prior ingest recorded, run a full ingest first", pr)
	}
	if headSHA == prevHead {
		return &ingestResult{PR: pr, Skipped: true}, nil
	}

	if err := ensureCommits(ctx, pr, baseSHA, headSHA); err != nil {
		return nil, fmt.Errorf("ensure commits: %w", err)
	}

	if baseSHA != prevBase {
		log.Printf("ingest refresh pr %d: base sha changed (%s -> %s), falling back to full ingest", pr, short(prevBase), short(baseSHA))
		shas, err := prepareIngestWorktreesLocked(ctx, dataDir, pr)
		if err != nil {
			return nil, fmt.Errorf("full ingest fallback: prepare worktrees: %w", err)
		}
		full, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, pr, shas)
		if err != nil {
			return nil, fmt.Errorf("full ingest fallback: scan and store: %w", err)
		}
		full.FullFallback = true
		return full, nil
	}

	baseDir, headDir := worktreeDirs(dataDir, pr)
	if err := updateWorktree(ctx, headDir, headSHA); err != nil {
		return nil, fmt.Errorf("update head worktree: %w", err)
	}

	deltaFiles, err := changedFileNames(ctx, prevHead, headSHA)
	if err != nil {
		return nil, fmt.Errorf("changed files: %w", err)
	}
	if len(deltaFiles) == 0 {
		if err := saveIngestSHAs(db, pr, baseSHA, headSHA); err != nil {
			return nil, fmt.Errorf("save ingest shas: %w", err)
		}
		return &ingestResult{PR: pr, Skipped: true}, nil
	}

	rawDiff, err := diffBetweenSHAs(ctx, baseSHA, headSHA, deltaFiles)
	if err != nil {
		return nil, fmt.Errorf("diff delta files: %w", err)
	}
	diffs := parseUnifiedDiff(rawDiff)

	blocks, perr := parseFiles(pr, deltaFiles, baseDir, headDir, diffs)
	for _, e := range perr {
		log.Printf("ingest refresh pr %d: parse warning: %v", pr, e)
	}

	if err := upsertPRFileBlocks(db, pr, deltaFiles, blocks); err != nil {
		return nil, fmt.Errorf("upsert delta blocks: %w", err)
	}
	if err := saveIngestSHAs(db, pr, baseSHA, headSHA); err != nil {
		return nil, fmt.Errorf("save ingest shas: %w", err)
	}

	res := &ingestResult{PR: pr, Stored: len(blocks), ByStatus: map[string]int{}}
	for _, b := range blocks {
		res.ByStatus[b.Status]++
	}
	log.Printf("ingest refresh pr %d: %d file(s) changed since %s, stored %d block(s) (%v)",
		pr, len(deltaFiles), short(prevHead), res.Stored, res.ByStatus)
	return res, nil
}
