package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/callresolve"
	"slash/modules/chat"
	"slash/modules/commentignore"
	"slash/modules/comments"
	"slash/modules/explanations"
	"slash/modules/github"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/testcovers"
	"slash/modules/warnrevoke"
)

// This file holds the pure, directly testable pieces of the `cleanup`
// workflow (candidate discovery, the two Activity bodies, and the actual
// disk/DB removal) — mirrors the ingest.go/workflows.go split: the Workflow
// Type registration + wiring lives in workflows.go, next to ingestWorkflow.
//
// What gets removed for a PR whose merge is older than the cutoff:
//  1. Its worktrees (data/worktrees/pr-<n>-{base,head}) — by far the biggest
//     disk win (see the storage breakdown in .claude/docs/tembed-workflows.md).
//  2. Its workflow runs (the .events.jsonl/.meta.jsonl files + the rows in
//     workflows.db) — every run whose stored input carries this pr, found the
//     same way RunsForPR does. A per-repo tracker (pr_inbox/task_inbox/
//     task_snooze) has no "pr" field in its input and is therefore never
//     touched.
//  3. Its rows in every read-model with a pr column: blocks + pr_ingest
//     (graph.db) plus comments/approvals/relations/callresolve/testcovers/
//     prmeta/explanations (each via that module's own Purge). There is no
//     "ignore" module anymore (removed, replaced by the task-level,
//     per-repo task_snooze) — nothing to purge there.

// cleanupMergedAge is how long after being merged a PR's data becomes
// eligible for cleanup.
const cleanupMergedAge = 7 * 24 * time.Hour

// retiredWorkflowTypes are Workflow Types that used to exist in this codebase
// but have since been permanently removed — the code that registered them is
// gone for good, not merely absent from one particular binary (the headless
// `slash ingest`/`relations`/`seed` CLI commands deliberately register only a
// subset of workflows via newTasks(..., resumeRuntime=false), which is a
// completely different, expected situation and must never be treated as
// "retired"). A run whose Workflow Type is in this map is thus a genuine
// orphan from before the removal: engine.Recover() logs "uses unregistered
// workflow" for it on every server start and it can never make progress
// again, so purgeRetiredWorkflowRuns permanently deletes it.
//
// This is a deliberately explicit, hand-maintained allowlist rather than
// "whatever engine.Runs() reports as currently unregistered" — the latter
// would risk deleting a perfectly legitimate run just because this
// particular process (e.g. the headless CLI) happens not to register that
// workflow type. Add a name here only once its registering code has been
// removed from the codebase entirely.
var retiredWorkflowTypes = map[string]bool{
	// The old per-PR "ignore" feature (a workflow + modules/ignore) was
	// replaced by the per-repo task_snooze workflow — see "Snoozing a task"
	// in .claude/docs/tembed-workflows.md. modules/ignore no longer exists.
	"ignore": true,
}

// CleanupInput starts a cleanup Execution. Cutoff is normally left zero — the
// workflow body fills it in deterministically via w.Now() — but can be set
// explicitly (e.g. by a test) to pin a specific point in time.
type CleanupInput struct {
	Cutoff time.Time `json:"cutoff"`
	// ForcePRs is a deliberate, explicitly-named override: each of these PR
	// numbers is purged unconditionally, bypassing the GitHub-merged/age gate
	// resolveCleanupTargets otherwise applies. Needed for a PR that can never
	// pass that gate at all — e.g. a synthetic/test PR number (no real PR to
	// look up, so gh.PRMeta always fails) that accidentally ended up in a live
	// data tree. Never populated automatically (the daily scheduler always
	// starts a bare CleanupInput{}) — only via the `slash cleanup -force
	// <pr,...>` CLI command, deliberately not exposed over HTTP, so there is
	// no standing endpoint that can force-purge an arbitrary PR.
	ForcePRs []int `json:"forcePRs,omitempty"`
}

// CleanupTarget is one PR the cleanup workflow decided to purge: merged, and
// merged before the cutoff.
type CleanupTarget struct {
	PR       int       `json:"pr"`
	MergedAt time.Time `json:"mergedAt"`
}

// CleanupTargets is resolveCleanupTargets's result.
type CleanupTargets struct {
	Cutoff  time.Time       `json:"cutoff"`
	Targets []CleanupTarget `json:"targets"`
}

// CleanupPurgeResult logs what purgePR actually removed for one PR.
type CleanupPurgeResult struct {
	PR                  int            `json:"pr"`
	WorktreesRemoved    int            `json:"worktreesRemoved"`
	WorkflowRunsDeleted int            `json:"workflowRunsDeleted"`
	RowsDeleted         map[string]int `json:"rowsDeleted"` // table/module name -> row count
}

// CleanupResult is the cleanup workflow's overall result.
type CleanupResult struct {
	Cutoff time.Time            `json:"cutoff"`
	Purged []CleanupPurgeResult `json:"purged"`
	// RetiredRunsDeleted is the number of orphaned runs of a permanently
	// retired Workflow Type (see retiredWorkflowTypes) removed this pass —
	// unconditional, not scoped to any one PR target above.
	RetiredRunsDeleted int `json:"retiredRunsDeleted"`
}

// reWorktreeDir extracts a PR number from a worktrees dir name: "pr-<n>-base"
// / "pr-<n>-head", or "pr-<n>-chatshadow-<conversationId>" — the per-
// conversation claude_chat edit worktree (chat_shadow.go). Including the
// latter here means a PR whose only remaining disk trace is a leftover,
// never-pushed chat shadow (normally reclaimed immediately after a successful
// push — see commitChatShadowEdits) still gets picked up as a cleanup
// candidate, the same self-healing reasoning cleanupCandidatePRs already
// documents for base/head.
var reWorktreeDir = regexp.MustCompile(`^pr-(\d+)-(base|head|chatshadow-.+)$`)

// cleanupCandidatePRs returns every PR number that currently has data on disk
// — a union of the blocks table, the pr_ingest table, and any worktree dir
// still present. Read-only. Using a union instead of only `blocks` makes a
// half-finished previous cleanup (e.g. blocks already deleted but a worktree
// still present after a crash) get picked up on the next run too —
// self-healing/idempotent.
func cleanupCandidatePRs(db *sql.DB, dataDir string) ([]int, error) {
	seen := map[int]bool{}

	rows, err := db.Query(`SELECT DISTINCT pr FROM blocks`)
	if err != nil {
		return nil, fmt.Errorf("query blocks prs: %w", err)
	}
	for rows.Next() {
		var pr int
		if err := rows.Scan(&pr); err != nil {
			rows.Close()
			return nil, err
		}
		seen[pr] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	rows2, err := db.Query(`SELECT DISTINCT pr FROM pr_ingest`)
	if err != nil {
		return nil, fmt.Errorf("query pr_ingest prs: %w", err)
	}
	for rows2.Next() {
		var pr int
		if err := rows2.Scan(&pr); err != nil {
			rows2.Close()
			return nil, err
		}
		seen[pr] = true
	}
	if err := rows2.Err(); err != nil {
		rows2.Close()
		return nil, err
	}
	rows2.Close()

	root, err := filepath.Abs(dataDir)
	if err != nil {
		root = dataDir
	}
	entries, _ := os.ReadDir(filepath.Join(root, "worktrees")) // missing dir is fine (best-effort)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		m := reWorktreeDir.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		if pr, err := strconv.Atoi(m[1]); err == nil {
			seen[pr] = true
		}
	}

	out := make([]int, 0, len(seen))
	for pr := range seen {
		out = append(out, pr)
	}
	sort.Ints(out)
	return out, nil
}

// resolveCleanupTargets determines which of the currently-stored PRs are
// really merged (not just closed) and merged before in.Cutoff — read-only
// (github + DB + disk reads), the cleanup workflow's first Activity. A PR
// that is not merged (open, or closed without merging), not yet old enough,
// or whose merge date can't be determined (a transient gh hiccup, or an
// unparsable timestamp) is simply left out — cleanup only ever removes data
// it's certain about.
func resolveCleanupTargets(ctx context.Context, gh github.Client, db *sql.DB, dataDir string, in CleanupInput) (CleanupTargets, error) {
	res := CleanupTargets{Cutoff: in.Cutoff}

	// Forced PRs are added unconditionally, before the ordinary candidates are
	// even looked up — no gh.PRMeta call for them at all (a synthetic PR number
	// has no real GitHub PR to look up, so that call would just fail anyway).
	forced := map[int]bool{}
	for _, pr := range in.ForcePRs {
		if pr <= 0 || forced[pr] {
			continue
		}
		forced[pr] = true
		res.Targets = append(res.Targets, CleanupTarget{PR: pr})
	}

	prs, err := cleanupCandidatePRs(db, dataDir)
	if err != nil {
		return res, fmt.Errorf("candidate prs: %w", err)
	}
	for _, pr := range prs {
		if forced[pr] {
			continue // already added above, unconditionally
		}
		meta, err := gh.PRMeta(ctx, pr)
		if err != nil {
			log.Printf("cleanup: pr %d: PRMeta failed, skipping: %v", pr, err)
			continue
		}
		if meta.MergedAt == "" {
			continue // not merged (open, or closed without merging) — never touch
		}
		mergedAt, err := time.Parse(time.RFC3339, meta.MergedAt)
		if err != nil {
			log.Printf("cleanup: pr %d: unparsable mergedAt %q, skipping: %v", pr, meta.MergedAt, err)
			continue
		}
		if mergedAt.After(in.Cutoff) {
			continue // merged, but not old enough yet
		}
		res.Targets = append(res.Targets, CleanupTarget{PR: pr, MergedAt: mergedAt})
	}
	return res, nil
}

// purgeDeps bundles everything purgePR needs to remove one PR's data — a
// plain struct (not a TaskManager method) so purgePR itself stays a pure,
// directly testable unit, mirroring scanAndStoreIngestBlocksLocked's split
// from the workflow wiring.
type purgeDeps struct {
	engine      *tembed.Engine
	db          *sql.DB
	dataDir     string
	comments    *comments.Module
	approvals   *approvals.Module
	relations   *relations.Module
	callresolve *callresolve.Module
	testcovers  *testcovers.Module
	prmeta      *prmeta.Module
	explain     *explanations.Module
	// commentignore holds which PR-wide comments the reviewer hid from the
	// block index — keyed per PR precisely so this sweep picks it up; see the
	// package doc of modules/commentignore.
	commentignore *commentignore.Module
	// chat holds the embedded Claude conversations (see chat_workflow.go);
	// each hangs off a comment thread that is itself purged via d.comments, but
	// the chat rows have their own store and need their own sweep.
	chat *chat.Module
	// warnrevoke holds the (pr, blockId, row) bookkeeping that suppresses a
	// repeat approval-revoke for the same code_warning finding (see
	// modules/warnrevoke); keyed per PR so this sweep picks it up.
	warnrevoke *warnrevoke.Module
}

// purgePR removes every trace of one PR's data: its worktrees, its workflow
// runs, and its rows in every read-model with a pr column. WRITE — the
// cleanup workflow's second Activity, called once per resolved target. Every
// module dependency is optionally nil (mirrors every other Activity in
// workflows.go, e.g. bumpReviewerUsage) so a caller that doesn't wire a given
// module simply skips that store instead of panicking — the underlying
// DELETE is unconditional on pr, so re-running it is always a no-op once the
// data is already gone (idempotent).
func purgePR(ctx context.Context, d purgeDeps, pr int) (CleanupPurgeResult, error) {
	res := CleanupPurgeResult{PR: pr, RowsDeleted: map[string]int{}}

	n, err := removePRWorktrees(ctx, d.dataDir, pr)
	if err != nil {
		return res, fmt.Errorf("remove worktrees: %w", err)
	}
	res.WorktreesRemoved = n

	if d.engine != nil {
		deleted, err := deletePRWorkflowRuns(d.engine, pr)
		if err != nil {
			return res, fmt.Errorf("delete workflow runs: %w", err)
		}
		res.WorkflowRunsDeleted = deleted
	}

	if d.db != nil {
		n, err := purgePRBlocks(d.db, pr)
		if err != nil {
			return res, fmt.Errorf("purge blocks: %w", err)
		}
		res.RowsDeleted["blocks"] = n
	}
	if d.comments != nil {
		n, err := d.comments.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge comments: %w", err)
		}
		res.RowsDeleted["comments"] = int(n)
	}
	if d.approvals != nil {
		n, err := d.approvals.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge approvals: %w", err)
		}
		res.RowsDeleted["approvals"] = int(n)
	}
	if d.relations != nil {
		n, err := d.relations.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge relations: %w", err)
		}
		res.RowsDeleted["relations"] = int(n)
	}
	if d.callresolve != nil {
		n, err := d.callresolve.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge callresolve: %w", err)
		}
		res.RowsDeleted["callresolve"] = int(n)
	}
	if d.testcovers != nil {
		n, err := d.testcovers.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge testcovers: %w", err)
		}
		res.RowsDeleted["testcovers"] = int(n)
	}
	if d.prmeta != nil {
		n, err := d.prmeta.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge prmeta: %w", err)
		}
		res.RowsDeleted["prmeta"] = int(n)
	}
	if d.explain != nil {
		n, err := d.explain.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge explanations: %w", err)
		}
		res.RowsDeleted["explanations"] = int(n)
	}
	if d.commentignore != nil {
		n, err := d.commentignore.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge commentignore: %w", err)
		}
		res.RowsDeleted["commentignore"] = int(n)
	}
	if d.chat != nil {
		n, err := d.chat.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge chat: %w", err)
		}
		res.RowsDeleted["chat"] = int(n)
	}
	if d.warnrevoke != nil {
		n, err := d.warnrevoke.Purge(ctx, pr)
		if err != nil {
			return res, fmt.Errorf("purge warnrevoke: %w", err)
		}
		res.RowsDeleted["warnrevoke"] = int(n)
	}

	log.Printf("cleanup pr %d: worktrees=%d workflow_runs=%d rows=%v",
		pr, res.WorktreesRemoved, res.WorkflowRunsDeleted, res.RowsDeleted)
	return res, nil
}

// removePRWorktrees deregisters (best-effort) and removes pr's base/head
// worktree directories. A directory that's already gone is simply skipped
// (idempotent — a repeated cleanup pass never errors on it).
func removePRWorktrees(ctx context.Context, dataDir string, pr int) (int, error) {
	baseDir, headDir := worktreeDirs(dataDir, pr)
	n := 0
	for _, dir := range []string{baseDir, headDir} {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			continue
		}
		// Deregister the git worktree first (best-effort — an already-broken
		// or non-worktree directory just falls through to the raw removal).
		_, _ = runGit(ctx, "worktree", "remove", "--force", dir)
		if err := os.RemoveAll(dir); err != nil {
			return n, fmt.Errorf("remove %s: %w", dir, err)
		}
		n++
	}

	// Any per-conversation claude_chat shadow worktree still on disk for this
	// PR (chat_shadow.go) — normally already reclaimed right after a
	// successful push, so this only matters for a conversation whose edits
	// were never committed/pushed, or whose own reclaim step failed. Unlike
	// base/head there can be any number of these, one per conversation, so a
	// prefix scan is needed instead of a fixed pair of paths.
	root, err := filepath.Abs(dataDir)
	if err != nil {
		root = dataDir
	}
	wtRoot := filepath.Join(root, "worktrees")
	entries, _ := os.ReadDir(wtRoot) // missing dir is fine (best-effort)
	prefix := fmt.Sprintf("pr-%d-chatshadow-", pr)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		dir := filepath.Join(wtRoot, e.Name())
		_, _ = runGit(ctx, "worktree", "remove", "--force", dir)
		if err := os.RemoveAll(dir); err != nil {
			return n, fmt.Errorf("remove %s: %w", dir, err)
		}
		// Best-effort: also drop the shadow's own local branch (chat/<id> —
		// see chatShadowBranch), otherwise it dangles in the shared clone
		// forever for a conversation that never committed/pushed.
		_, _ = runGit(ctx, "branch", "-D", "chat/"+strings.TrimPrefix(e.Name(), prefix))
		n++
	}

	// Best-effort: clean up any leftover worktree admin entries in the main repo.
	_, _ = runGit(ctx, "worktree", "prune")
	return n, nil
}

// deletePRWorkflowRuns removes every workflow run whose stored input carries
// pr — the same "pr" field RunsForPR (tasks_api.go) matches on, so a
// per-repo tracker (pr_inbox/task_inbox/task_snooze, no "pr" field) is never
// touched. Returns the number of runs deleted.
func deletePRWorkflowRuns(engine *tembed.Engine, pr int) (int, error) {
	runs, err := engine.Runs()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range runs {
		in, err := engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input struct {
			PR int `json:"pr"`
		}
		if json.Unmarshal(in, &input) != nil || input.PR != pr {
			continue
		}
		if err := engine.DeleteRun(r.ID); err != nil {
			return n, fmt.Errorf("delete run %s: %w", r.ID, err)
		}
		n++
	}
	return n, nil
}

// purgeRetiredWorkflowRuns removes every run whose Workflow Type is in
// retiredWorkflowTypes (see its own doc comment) — permanent orphans left
// over from a feature that no longer exists. Unlike deletePRWorkflowRuns
// this is not scoped to one PR: it runs once per cleanup pass, independent
// of the resolved PR targets. Returns the number of runs deleted.
func purgeRetiredWorkflowRuns(engine *tembed.Engine) (int, error) {
	runs, err := engine.Runs()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range runs {
		if !retiredWorkflowTypes[r.Workflow] {
			continue
		}
		if err := engine.DeleteRun(r.ID); err != nil {
			return n, fmt.Errorf("delete retired run %s (%s): %w", r.ID, r.Workflow, err)
		}
		n++
	}
	return n, nil
}
