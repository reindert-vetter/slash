package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"path/filepath"
	"strings"
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
	// PrevBaseSHA/PrevHeadSHA are the SHAs this PR was last ingested at, before
	// this refresh moved them on, and ChangedFiles the paths it re-scanned. The
	// re-anchor pass (reanchor.go, driven from prStatusWorkflow) needs all three:
	// the paths to know which stored anchors can have gone stale, and the previous
	// SHAs to rebuild the aligned-row space an approval was written in — the head
	// worktree has by then already been checked out to the new SHA in place.
	//
	// Recorded here rather than re-read from pr_ingest afterwards because the
	// refresh has already overwritten those rows by the time it returns, and
	// because a workflow must take such values from a recorded Activity result to
	// stay replay-deterministic.
	PrevBaseSHA  string   `json:"prevBaseSHA,omitempty"`
	PrevHeadSHA  string   `json:"prevHeadSHA,omitempty"`
	ChangedFiles []string `json:"changedFiles,omitempty"`
}

// worktreeDirs returns absolute base/head worktree paths for a PR under
// data/worktrees. They MUST be absolute: `git -C <repo> worktree add <dir>`
// resolves a relative <dir> against the repo dir, not our CWD.
func worktreeDirs(dataDir string, repo string, pr int) (base, head string) {
	root, err := filepath.Abs(dataDir)
	if err != nil {
		root = dataDir
	}
	// A second repo's worktrees carry its key up front ("ops-pr-12-base"), so the
	// primary repo's directory names — which cleanup.go's scanner and every
	// existing on-disk worktree already use — stay exactly "pr-<n>-base|head".
	prefix := ""
	if repo != "" {
		prefix = repoKeyOf(repo) + "-"
	}
	base = filepath.Join(root, "worktrees", fmt.Sprintf("%spr-%d-base", prefix, pr))
	head = filepath.Join(root, "worktrees", fmt.Sprintf("%spr-%d-head", prefix, pr))
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
func prepareIngestWorktrees(ctx context.Context, dataDir string, repo string, pr int) (worktreeSHAs, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()
	return prepareIngestWorktreesLocked(ctx, dataDir, repo, pr)
}

// prepareIngestWorktreesLocked is prepareIngestWorktrees's body, extracted so
// refreshIngestDelta (which already holds ingestMu) can fall back to a full
// ingest without re-locking a non-reentrant mutex.
func prepareIngestWorktreesLocked(ctx context.Context, dataDir string, repo string, pr int) (worktreeSHAs, error) {
	meta, err := fetchPRMeta(ctx, repo, pr)
	if err != nil {
		return worktreeSHAs{}, err
	}
	baseSHA, headSHA := meta.BaseRefOid, meta.HeadRefOid
	if baseSHA == "" || headSHA == "" {
		return worktreeSHAs{}, fmt.Errorf("pr %d: missing base/head SHA in metadata", pr)
	}
	log.Printf("ingest pr %d: base=%s head=%s files=%d", pr, short(baseSHA), short(headSHA), len(meta.Files))

	if err := ensureCommits(ctx, repo, pr, baseSHA, headSHA); err != nil {
		return worktreeSHAs{}, err
	}

	// The base worktree must hold the commit the PR BRANCHED OFF, not the current
	// tip of the base branch: anything develop received since then is not part of
	// this PR, and a two-dot diff would report it as a deletion. See mergeBaseSHA.
	if mb := mergeBaseSHA(ctx, repo, baseSHA, headSHA); mb != baseSHA {
		log.Printf("ingest pr %d: base -> merge base %s", pr, short(mb))
		baseSHA = mb
	}

	baseDir, headDir := worktreeDirs(dataDir, repo, pr)
	if err := ensureWorktree(ctx, repo, baseDir, baseSHA); err != nil {
		return worktreeSHAs{}, fmt.Errorf("base worktree: %w", err)
	}
	if err := ensureWorktree(ctx, repo, headDir, headSHA); err != nil {
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
func scanAndStoreIngestBlocks(ctx context.Context, db *sql.DB, dataDir string, repo string, pr int, shas worktreeSHAs) (*ingestResult, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()
	return scanAndStoreIngestBlocksLocked(ctx, db, dataDir, repo, pr, shas)
}

// scanAndStoreIngestBlocksLocked is scanAndStoreIngestBlocks's body, extracted
// so refreshIngestDelta (which already holds ingestMu) can fall back to a full
// ingest without re-locking a non-reentrant mutex.
func scanAndStoreIngestBlocksLocked(ctx context.Context, db *sql.DB, dataDir string, repo string, pr int, shas worktreeSHAs) (*ingestResult, error) {
	res := &ingestResult{PR: pr, ByStatus: map[string]int{}}

	// Read the SHAs the blocks table currently holds BEFORE replacing it, so the
	// re-anchor pass can rebuild the aligned-row space every stored comment/
	// approval anchor was written in (see reanchor.go). Without this a manual
	// re-ingest ("Regenereren", or `slash ingest`) after new commits landed would
	// swap in a fresh row space and leave every anchor of a changed file pointing
	// at whatever code took its index — and worse, saveIngestSHAs below then makes
	// the delta poller report Skipped for that same delta, so the refresh path
	// would never repair it either.
	//
	// Absent (no prior ingest) is the normal first-ingest case: nothing can be
	// stale yet, and the empty SHAs make the approval remap a no-op.
	prevBase, prevHead, _, err := loadIngestSHAs(db, repo, pr)
	if err != nil {
		return nil, fmt.Errorf("load previous ingest state: %w", err)
	}
	res.PrevBaseSHA, res.PrevHeadSHA = prevBase, prevHead
	// A full swap re-scans everything, so every path of the PR may hold a stale
	// anchor — not just a delta. That also makes one re-ingest repair anchors that
	// went stale before this pass existed.
	res.ChangedFiles = shas.Paths

	baseDir, headDir := worktreeDirs(dataDir, repo, pr)

	// Detect git renames (default -M threshold) so a moved file is scanned as
	// one logical file (old blocks from the pre-rename path in the base
	// worktree, new blocks from the head path) instead of a removed+added pair.
	// Best-effort: a failure just means no rename pairing.
	renames, rerr := detectRenames(ctx, repo, shas.BaseSHA, shas.HeadSHA)
	if rerr != nil {
		log.Printf("ingest pr %d: rename detection failed (continuing without): %v", pr, rerr)
		renames = nil
	}
	oldSet := make(map[string]bool, len(renames))
	for _, old := range renames {
		oldSet[old] = true
	}

	// scanPaths are the new (head) paths to parse; drop any that are a rename
	// source (defensive — gh normally lists only the new path for a rename).
	scanPaths := make([]string, 0, len(shas.Paths))
	for _, p := range shas.Paths {
		if !oldSet[p] {
			scanPaths = append(scanPaths, p)
		}
	}
	// The diff must also see the old paths so git can pair each rename hunk
	// under its new path (a pathspec limited to only the new path suppresses
	// rename detection — see diffBetweenSHAs).
	diffPaths := append([]string{}, scanPaths...)
	for _, old := range renames {
		diffPaths = append(diffPaths, old)
	}

	rawDiff, err := diffBetweenSHAs(ctx, repo, shas.BaseSHA, shas.HeadSHA, diffPaths)
	if err != nil {
		return nil, fmt.Errorf("diff: %w", err)
	}
	diffs := parseUnifiedDiff(rawDiff)

	blocks, perr := parseFiles(pr, scanPaths, renames, baseDir, headDir, diffs)
	for _, e := range perr {
		res.Warnings = append(res.Warnings, e.Error())
		log.Printf("ingest pr %d: parse warning: %v", pr, e)
	}
	if len(blocks) == 0 && len(scanPaths) > 0 {
		return nil, fmt.Errorf("pr %d: parsed zero blocks from %d files", pr, len(scanPaths))
	}

	if err := replacePRBlocks(db, repo, pr, blocks); err != nil {
		return nil, err
	}
	// Record the SHAs this full ingest populated the blocks table from, so a
	// later refreshIngestDelta knows exactly which head SHA to diff from.
	if err := saveIngestSHAs(db, repo, pr, shas.BaseSHA, shas.HeadSHA); err != nil {
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
func refreshIngestDelta(ctx context.Context, db *sql.DB, dataDir string, repo string, pr int, baseSHA, headSHA string) (*ingestResult, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	prevBase, prevHead, ok, err := loadIngestSHAs(db, repo, pr)
	if err != nil {
		return nil, fmt.Errorf("load ingest state: %w", err)
	}
	if !ok {
		return nil, fmt.Errorf("pr %d: no prior ingest recorded, run a full ingest first", pr)
	}
	if headSHA == prevHead {
		return &ingestResult{PR: pr, Skipped: true}, nil
	}

	if err := ensureCommits(ctx, repo, pr, baseSHA, headSHA); err != nil {
		return nil, fmt.Errorf("ensure commits: %w", err)
	}

	// Normalize to the merge base BEFORE comparing against prevBase (which is
	// itself a stored merge base). The pr_status poller signals the raw
	// baseRefOid, so without this every commit landing on develop would look
	// like a moved base and force a needless full re-ingest; with it the
	// fallback below fires only on a real rebase or a base-branch merge INTO
	// the head — exactly what it is for. Idempotent for the caller that already
	// passes the stored base (chat_merge.go). See mergeBaseSHA.
	baseSHA = mergeBaseSHA(ctx, repo, baseSHA, headSHA)

	// A rebase/force-push can rewrite the PR's own commits without moving the
	// resolved merge base at all (e.g. squashing onto the same base tip), which
	// the baseSHA != prevBase check right below cannot see — yet it leaves
	// prevHead unreachable from the new headSHA, so a prevHead..headSHA diff
	// below is no longer a meaningful "what changed since the last refresh"
	// (see isAncestor's own doc comment). Fall back to a full ingest exactly
	// like a moved base does, rather than risk a delta that silently misses
	// files. "Rebase zonder dat er gepushed is, kan voorkomen" — this is not
	// gated on gh/network at all, so it also catches a rebase the poller only
	// ever observed as "the head SHA changed", with no separate signal.
	if baseSHA != prevBase || !isAncestor(ctx, repo, prevHead, headSHA) {
		if baseSHA != prevBase {
			log.Printf("ingest refresh pr %d: base sha changed (%s -> %s), falling back to full ingest", pr, short(prevBase), short(baseSHA))
		} else {
			log.Printf("ingest refresh pr %d: prevHead %s is not an ancestor of head %s (rebase/force-push), falling back to full ingest", pr, short(prevHead), short(headSHA))
		}
		shas, err := prepareIngestWorktreesLocked(ctx, dataDir, repo, pr)
		if err != nil {
			return nil, fmt.Errorf("full ingest fallback: prepare worktrees: %w", err)
		}
		full, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, repo, pr, shas)
		if err != nil {
			return nil, fmt.Errorf("full ingest fallback: scan and store: %w", err)
		}
		// PrevBaseSHA/PrevHeadSHA/ChangedFiles are filled by
		// scanAndStoreIngestBlocksLocked itself (it reads the pre-swap SHAs), so
		// the re-anchor pass covers this path exactly like a delta refresh.
		full.FullFallback = true
		return full, nil
	}

	baseDir, headDir := worktreeDirs(dataDir, repo, pr)
	if err := updateWorktree(ctx, repo, headDir, headSHA); err != nil {
		return nil, fmt.Errorf("update head worktree: %w", err)
	}

	deltaFiles, err := changedFileNames(ctx, repo, prevHead, headSHA)
	if err != nil {
		return nil, fmt.Errorf("changed files: %w", err)
	}

	// A delta may never WIDEN the PR's file set. deltaFiles is the diff over
	// prevHead..headSHA, so merging the base branch INTO the head (a reviewer
	// pulling develop into his feature branch) drags in every file that branch
	// touched meanwhile — hundreds of files that are not part of this PR at all,
	// each stored as PR blocks and then explained, warned about and waiting to be
	// approved. The base-SHA guard above cannot catch that on its own: the caller
	// may pass a base that has not moved (refreshTreeAfterLanding deliberately
	// pins the recorded one) while the head has just absorbed that whole branch.
	//
	// So the file set is intersected with the PR's own changed files, computed
	// LOCALLY as a merge-base..head diff (prLocalChangedFilePaths) rather than
	// via a fresh `gh pr view` snapshot. GitHub's own "files" list can still be
	// computing right after a push and briefly under-report — the same kind of
	// race the ghFilesPageSize truncation guard already works around elsewhere
	// in this file — and a refresh that raced against that window used to
	// silently drop the just-pushed files from this filter, forever (headSHA is
	// saved regardless, so the next poll sees no change and never retries). See
	// "A delta refresh must not depend on gh for its own widening guard" in
	// .claude/docs/blocks-and-ingest.md. Best-effort: a local diff failure
	// (e.g. one of the SHAs somehow not fetched) means no filter, never a
	// failed refresh.
	// anySkipped tracks whether the widening filter actually dropped anything
	// this round. When it did, saveIngestSHAs below is deliberately SKIPPED —
	// prevHead/prevBase are left exactly as they were — so the next poll tick
	// (headSHA has not "advanced" as far as pr_ingest is concerned) redoes the
	// exact same delta+filter rather than permanently committing to a result
	// that dropped something. This is the same shape of bug as the gh-race
	// above, one level more defensive: even though the widening guard is now
	// pure local git and should always be correct, never let "we filtered
	// something out" and "we successfully captured the whole PR" look like
	// the same outcome to the next poll. Accepted trade-off: a PR that
	// legitimately, permanently absorbed a base-branch merge (the very
	// scenario this filter exists for) re-runs this same filtered delta on
	// every poll tick forever, since headSHA/prevHead never converge — wasted
	// work, but idempotent and never incorrect (see "A delta refresh must not
	// depend on gh for its own widening guard" in
	// .claude/docs/blocks-and-ingest.md).
	anySkipped := false
	if prFiles, ferr := prLocalChangedFilePaths(ctx, repo, headSHA); ferr != nil {
		log.Printf("ingest refresh pr %d: pr file list unavailable (%v), delta not filtered", pr, ferr)
	} else {
		if kept := filterToPRFiles(deltaFiles, prFiles); len(kept) != len(deltaFiles) {
			log.Printf("ingest refresh pr %d: %d of %d changed file(s) are outside the PR, skipped",
				pr, len(deltaFiles)-len(kept), len(deltaFiles))
			deltaFiles = kept
			anySkipped = true
		}
		// Repair a PR whose blocks were already widened by an earlier refresh (or
		// whose rename left its old path behind), so this heals itself instead of
		// needing a manual "Regenereren".
		if n, perr := pruneBlocksOutsidePRFiles(db, repo, pr, prFiles); perr != nil {
			log.Printf("ingest refresh pr %d: prune blocks outside the PR: %v", pr, perr)
		} else if n > 0 {
			log.Printf("ingest refresh pr %d: pruned %d block(s) for files outside the PR", pr, n)
		}
	}

	if len(deltaFiles) == 0 {
		if !anySkipped {
			if err := saveIngestSHAs(db, repo, pr, baseSHA, headSHA); err != nil {
				return nil, fmt.Errorf("save ingest shas: %w", err)
			}
		} else {
			log.Printf("ingest refresh pr %d: leaving prevHead at %s (some file(s) were filtered out this round), next poll retries", pr, short(prevHead))
		}
		return &ingestResult{PR: pr, Skipped: true}, nil
	}

	rawDiff, err := diffBetweenSHAs(ctx, repo, baseSHA, headSHA, deltaFiles)
	if err != nil {
		return nil, fmt.Errorf("diff delta files: %w", err)
	}
	diffs := parseUnifiedDiff(rawDiff)

	// Delta-refresh keeps the deliberate --no-renames split (see changedFileNames):
	// a rename appearing mid-refresh stays removed+added until a full re-ingest.
	blocks, perr := parseFiles(pr, deltaFiles, nil, baseDir, headDir, diffs)
	for _, e := range perr {
		log.Printf("ingest refresh pr %d: parse warning: %v", pr, e)
	}

	if err := upsertPRFileBlocks(db, repo, pr, deltaFiles, blocks); err != nil {
		return nil, fmt.Errorf("upsert delta blocks: %w", err)
	}
	if !anySkipped {
		if err := saveIngestSHAs(db, repo, pr, baseSHA, headSHA); err != nil {
			return nil, fmt.Errorf("save ingest shas: %w", err)
		}
	} else {
		log.Printf("ingest refresh pr %d: leaving prevHead at %s (some file(s) were filtered out this round), next poll retries", pr, short(prevHead))
	}

	res := &ingestResult{PR: pr, Stored: len(blocks), ByStatus: map[string]int{},
		PrevBaseSHA: prevBase, PrevHeadSHA: prevHead, ChangedFiles: deltaFiles}
	for _, b := range blocks {
		res.ByStatus[b.Status]++
	}
	log.Printf("ingest refresh pr %d: %d file(s) changed since %s, stored %d block(s) (%v)",
		pr, len(deltaFiles), short(prevHead), res.Stored, res.ByStatus)
	return res, nil
}

// prLocalChangedFilePaths is the PR's own changed-file set computed purely
// from LOCAL git — a merge-base..head diff (changedFileNames), the same
// three-dot comparison GitHub's own "Files changed" tab is built on (see
// mergeBaseSHA) — instead of a fresh `gh pr view --json files` snapshot.
// Replaced the former gh-based prChangedFilePaths for this one call site
// (refreshIngestDelta's widening guard): unlike gh, this cannot lag behind a
// push.
//
// Deliberately re-resolves the base branch's LIVE tip itself (one
// `git fetch origin <branch>` + `rev-parse`) instead of reusing whatever
// baseSHA the caller passed to refreshIngestDelta: refreshTreeAfterLanding
// (chat_merge.go) deliberately PINS the previously-recorded base so a landed
// chat edit stays a fast delta, but the reviewer's own branch can still have
// a base-branch merge embedded in it by the time it lands — and
// mergeBaseSHA(pinnedBase, headSHA) simply returns pinnedBase unchanged
// whenever pinnedBase is already an ancestor of headSHA, whether or not
// headSHA has since absorbed such a merge. Re-resolving against the live
// branch tip sidesteps the pin entirely: git's own ref advertisement is
// atomic (no separate "files" computation that can lag the way GitHub's API
// list could), so this closes the widening guard's original gap without
// depending on gh. Best-effort: a fetch failure just means the fetch is
// skipped and whatever tip is already known locally is used.
func prLocalChangedFilePaths(ctx context.Context, repo string, headSHA string) ([]string, error) {
	branch := baseBranchFor(repo)
	if _, err := runGitFor(ctx, repo, "fetch", "origin", branch); err != nil {
		log.Printf("prLocalChangedFilePaths: fetch %s failed (using local ref as-is): %v", branch, err)
	}
	out, err := runGitFor(ctx, repo, "rev-parse", "origin/"+branch)
	if err != nil {
		return nil, fmt.Errorf("resolve base branch %s tip: %w", branch, err)
	}
	liveBase := strings.TrimSpace(string(out))
	mb := mergeBaseSHA(ctx, repo, liveBase, headSHA)

	files, err := changedFileNames(ctx, repo, mb, headSHA)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no changed files between %s and %s", short(mb), short(headSHA))
	}
	return files, nil
}

// filterToPRFiles keeps only the delta paths that are part of the PR, in their
// original order. Pure, so the widening case is unit-testable without gh.
func filterToPRFiles(delta, prFiles []string) []string {
	allowed := make(map[string]bool, len(prFiles))
	for _, f := range prFiles {
		allowed[f] = true
	}
	kept := make([]string, 0, len(delta))
	for _, f := range delta {
		if allowed[f] {
			kept = append(kept, f)
		}
	}
	return kept
}
