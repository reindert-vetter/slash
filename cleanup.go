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
//     same way RunsForPR does. A per-repo tracker (pr_inbox/auto_warn/
//     app_settings) has no "pr" field in its input and is therefore never
//     touched.
//  3. Its rows in every read-model with a pr column: blocks + pr_ingest
//     (graph.db) plus comments/approvals/relations/callresolve/testcovers/
//     prmeta/explanations (each via that module's own Purge). There is no
//     "ignore" module anymore (removed) — nothing to purge there.

// cleanupMergedAge is how long after being merged a PR's data becomes
// eligible for cleanup.
const cleanupMergedAge = 7 * 24 * time.Hour

// testRunResidueAge is how long a test_run run's own leftover residue (git
// clean candidates recorded on its Activity result, see test_run.go) is left
// alone before this pass sweeps it. Deliberately independent of
// cleanupMergedAge/whether the PR itself is merged — the reviewer's own
// words: "alleen weghalen wat ouder is dan 3 dagen", about the residue only,
// not about the PR's data as a whole. What is younger than this is only ever
// REPORTED (test_run.go's own progress panel keeps the checkout-dirty
// warning visible), never touched by this pass.
const testRunResidueAge = 3 * 24 * time.Hour

// debugLogRunAge is how long a COMPLETED debug_log one-shot's run record is
// kept before sweepDebugLogRuns deletes it. Short on purpose: the record has
// no value once the batch is on disk, and a debugging session can produce
// hundreds of them. Only the runs are swept — never debug-log.jsonl itself.
const debugLogRunAge = time.Hour

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
	// The task inbox (task_inbox, aggregation) and its per-repo task_snooze
	// tracker — the "/inbox" personal to-do list — were removed outright
	// (not replaced by anything): modules/taskinbox, modules/tasksnooze and
	// taskinbox_analysis.go no longer exist. Any pre-existing Execution of
	// either type is a genuine orphan, purged the same way as "ignore" above.
	"task_inbox":  true,
	"task_snooze": true,
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
	// PlanArtifactsRemoved is the number of planning-phase directories
	// (data/plans/<KEY>, holding intent.md/spec.md/plan.md — see
	// plan_artifacts.go) removed with this PR. Normally 0 or 1: only a plan
	// whose plan_execute really opened this PR carries its marker. This is the
	// reviewer's own "mag worden weggegooid als de pr is gemerged", riding on
	// the merged-and-old gate that already decided this PR is purgeable rather
	// than becoming a second cleanup mechanism.
	PlanArtifactsRemoved int `json:"planArtifactsRemoved,omitempty"`
}

// CleanupResult is the cleanup workflow's overall result.
type CleanupResult struct {
	Cutoff time.Time            `json:"cutoff"`
	Purged []CleanupPurgeResult `json:"purged"`
	// RetiredRunsDeleted is the number of orphaned runs of a permanently
	// retired Workflow Type (see retiredWorkflowTypes) removed this pass —
	// unconditional, not scoped to any one PR target above.
	RetiredRunsDeleted int `json:"retiredRunsDeleted"`
	// OrphanCommentRunsDeleted is the number of task_code_comment runs removed
	// this pass because their own comment no longer exists in comments.db (see
	// purgeOrphanCommentRuns) — unconditional, not scoped to any one PR target
	// or to the merged/age gate above.
	OrphanCommentRunsDeleted int `json:"orphanCommentRunsDeleted"`
	// DebugLogRunsDeleted is the number of completed debug_log one-shots whose
	// run record was removed this pass (see sweepDebugLogRuns) — the appended
	// debug-log.jsonl lines themselves are deliberately kept.
	DebugLogRunsDeleted int `json:"debugLogRunsDeleted"`
	// TestRunResidueSwept is the number of test_run runs whose own leftover
	// residue (git clean candidates older than testRunResidueAge) was removed
	// this pass — see sweepTestRunResidue. Unconditional, not scoped to any
	// one PR target or to the merged/age gate above: this is about the AGE of
	// the residue itself, never about whether a PR is merged.
	TestRunResidueSwept int `json:"testRunResidueSwept"`
	// JiraNotificationsPurged is the number of Jira notifications deleted this
	// pass because they are older than jiraNotifyRetention (30 days) — see
	// jira_notifications.go. Unconditional and PR-independent: a notification
	// belongs to a Jira issue, never to a PR.
	JiraNotificationsPurged int `json:"jiraNotificationsPurged"`
	// PlanArtifactsSwept is the number of planning-phase directories removed
	// this pass because they never reached a pull request AND have not been
	// touched for planArtifactAge (see sweepPlanArtifacts). The safety net
	// under the per-PR rule above, so an abandoned or half-finished plan is
	// not the one thing in data/ nobody ever cleans. Unconditional and
	// PR-independent, exactly like the test_run residue sweep.
	PlanArtifactsSwept int `json:"planArtifactsSwept"`
}

// reWorktreeDir extracts a PR number from a worktrees dir name: "pr-<n>-base"
// / "pr-<n>-head", or "pr-<n>-chatshadow-<conversationId>" — the LEGACY
// per-conversation claude_chat edit worktree this app used before
// chat_checkout.go replaced it with a shared local checkout. New PRs never
// create one of these any more; this pattern only exists so a leftover from
// before that migration (normally reclaimed immediately after a successful
// push, back when that concept existed) still gets swept, the same
// self-healing reasoning cleanupCandidatePRs already documents for base/head.
var reWorktreeDir = regexp.MustCompile(`^pr-(\d+)-(base|head|chatshadow-.+)$`)

// cleanupRepo scopes the whole retention pass to the PRIMARY repo (see repos.go).
// A DELIBERATE limitation of the multi-repo work, recorded here rather than left
// implicit: cleanup discovers candidates by PR NUMBER (from blocks/pr_ingest and
// the worktree directory names) and reports them as bare numbers in its result,
// so a second repo's PR 12 and the primary repo's PR 12 are indistinguishable to
// it — and purging the wrong one would delete a reviewer's approvals. Until this
// pass is reworked to carry (repo, number) end to end, another repo's data is
// simply never auto-purged: it accumulates (a few worktrees + derived rows) and
// can be removed by hand. Everything cleanup touches is derived data.
const cleanupRepo = ""

// cleanupCandidatePRs returns every PR number that currently has data on disk
// — a union of the blocks table, the pr_ingest table, and any worktree dir
// still present. Read-only. Using a union instead of only `blocks` makes a
// half-finished previous cleanup (e.g. blocks already deleted but a worktree
// still present after a crash) get picked up on the next run too —
// self-healing/idempotent.
func cleanupCandidatePRs(db *sql.DB, dataDir string) ([]int, error) {
	seen := map[int]bool{}

	rows, err := db.Query(`SELECT DISTINCT pr FROM blocks WHERE repo = ?`, cleanupRepo)
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

	rows2, err := db.Query(`SELECT DISTINCT pr FROM pr_ingest WHERE repo = ?`, cleanupRepo)
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

// isPRNotFoundErr reports whether err is gh's own DEFINITIVE "this PR number
// does not exist" response — a REST 404, which `gh api` itself renders as a
// "gh: Not Found (HTTP 404)"-shaped stderr line (see Module.api's stderr
// capture in modules/github/github.go). Deliberately narrow: a transient
// failure (network hiccup, auth issue, rate limit) never contains "HTTP 404"
// and must never be treated as grounds to purge data.
func isPRNotFoundErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "HTTP 404")
}

// orphanRunPRs returns every PR number referenced by a workflow run's stored
// "pr" input field (the same field deletePRWorkflowRuns/RunsForPR match on)
// that is NOT already in known — i.e. a PR that has trackers/comment-import
// runs going but was never actually ingested (no blocks/pr_ingest row, no
// worktree). Typically a synthetic/test PR number that ended up started
// against a live server by mistake (see "Reserved PR numbers" in
// .claude/docs/testing-playwright.md) — the daily cleanup pass otherwise
// never even considers it, since cleanupCandidatePRs has no other way to
// find it. Read-only.
func orphanRunPRs(engine *tembed.Engine, known map[int]bool) ([]int, error) {
	runs, err := engine.Runs()
	if err != nil {
		return nil, err
	}
	seen := map[int]bool{}
	for _, r := range runs {
		in, err := engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input struct {
			PR int `json:"pr"`
		}
		if json.Unmarshal(in, &input) != nil || input.PR <= 0 || known[input.PR] {
			continue
		}
		seen[input.PR] = true
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
//
// engine is used only for the orphan-run-only pass below (see orphanRunPRs);
// a nil engine (existing callers/tests that don't exercise that pass) simply
// skips it, exactly as before this pass existed.
func resolveCleanupTargets(ctx context.Context, gh github.Client, db *sql.DB, dataDir string, engine *tembed.Engine, in CleanupInput) (CleanupTargets, error) {
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

	// Orphan-run-only candidates: never ingested (no blocks/pr_ingest/worktree
	// trace), so invisible to cleanupCandidatePRs above, yet still have
	// workflow runs referencing them. Purged only when gh gives a DEFINITIVE
	// "this PR number does not exist" (isPRNotFoundErr) — a real PR that
	// simply hasn't been ingested yet (e.g. its pr_status tracker started but
	// nobody clicked "Generate review tree") reports no error at all and is
	// correctly left alone; likewise any transient gh failure.
	if engine != nil {
		known := map[int]bool{}
		for _, pr := range prs {
			known[pr] = true
		}
		for pr := range forced {
			known[pr] = true
		}
		orphanPRs, err := orphanRunPRs(engine, known)
		if err != nil {
			return res, fmt.Errorf("orphan run prs: %w", err)
		}
		for _, pr := range orphanPRs {
			if _, err := gh.PRMeta(ctx, pr); !isPRNotFoundErr(err) {
				continue // exists, or an inconclusive error — never guess
			}
			res.Targets = append(res.Targets, CleanupTarget{PR: pr})
		}
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

	n, err := removePRWorktrees(ctx, d.dataDir, cleanupRepo, pr)
	if err != nil {
		return res, fmt.Errorf("remove worktrees: %w", err)
	}
	res.WorktreesRemoved = n

	// A PR that is purged is merged/closed and gone from the review tree, so a
	// pending ref that was never pushed has nothing left to belong to — sweeping
	// it keeps refs/slash/pending/ from accumulating dead refs (pending_push.go).
	removePendingRefs(ctx, cleanupRepo, pr)

	if d.engine != nil {
		deleted, err := deletePRWorkflowRuns(d.engine, pr)
		if err != nil {
			return res, fmt.Errorf("delete workflow runs: %w", err)
		}
		res.WorkflowRunsDeleted = deleted
	}

	if d.db != nil {
		n, err := purgePRBlocks(d.db, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge blocks: %w", err)
		}
		res.RowsDeleted["blocks"] = n
	}
	if d.comments != nil {
		n, err := d.comments.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge comments: %w", err)
		}
		res.RowsDeleted["comments"] = int(n)
	}
	if d.approvals != nil {
		n, err := d.approvals.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge approvals: %w", err)
		}
		res.RowsDeleted["approvals"] = int(n)
	}
	if d.relations != nil {
		n, err := d.relations.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge relations: %w", err)
		}
		res.RowsDeleted["relations"] = int(n)
	}
	if d.callresolve != nil {
		n, err := d.callresolve.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge callresolve: %w", err)
		}
		res.RowsDeleted["callresolve"] = int(n)
	}
	if d.testcovers != nil {
		n, err := d.testcovers.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge testcovers: %w", err)
		}
		res.RowsDeleted["testcovers"] = int(n)
	}
	if d.prmeta != nil {
		n, err := d.prmeta.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge prmeta: %w", err)
		}
		res.RowsDeleted["prmeta"] = int(n)
	}
	if d.explain != nil {
		n, err := d.explain.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge explanations: %w", err)
		}
		res.RowsDeleted["explanations"] = int(n)
	}
	if d.commentignore != nil {
		n, err := d.commentignore.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge commentignore: %w", err)
		}
		res.RowsDeleted["commentignore"] = int(n)
	}
	if d.chat != nil {
		n, err := d.chat.Purge(ctx, cleanupRepo, pr)
		if err != nil {
			return res, fmt.Errorf("purge chat: %w", err)
		}
		res.RowsDeleted["chat"] = int(n)
	}

	// The plan that produced this PR: its three phase artifacts go with it (see
	// plan_artifacts.go). Inside the EXISTING purgePR Activity rather than as
	// an Activity of its own, so the cleanup workflow's own history is
	// unchanged.
	planDirs, err := removePlanArtifactsForPR(d.dataDir, pr)
	if err != nil {
		return res, fmt.Errorf("remove plan artifacts: %w", err)
	}
	res.PlanArtifactsRemoved = planDirs

	log.Printf("cleanup pr %d: worktrees=%d workflow_runs=%d plan_artifacts=%d rows=%v",
		pr, res.WorktreesRemoved, res.WorkflowRunsDeleted, res.PlanArtifactsRemoved, res.RowsDeleted)
	return res, nil
}

// removePRWorktrees deregisters (best-effort) and removes pr's base/head
// worktree directories. A directory that's already gone is simply skipped
// (idempotent — a repeated cleanup pass never errors on it).
func removePRWorktrees(ctx context.Context, dataDir string, repo string, pr int) (int, error) {
	baseDir, headDir := worktreeDirs(dataDir, repo, pr)
	n := 0
	for _, dir := range []string{baseDir, headDir} {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			continue
		}
		// Deregister the git worktree first (best-effort — an already-broken
		// or non-worktree directory just falls through to the raw removal).
		_, _ = runGitFor(ctx, repo, "worktree", "remove", "--force", dir)
		if err := os.RemoveAll(dir); err != nil {
			return n, fmt.Errorf("remove %s: %w", dir, err)
		}
		n++
	}

	// LEGACY: any per-conversation claude_chat shadow worktree still on disk
	// from before chat_checkout.go replaced it with a shared local checkout —
	// no PR ever creates a new one any more, but an old one left over from
	// before that migration (never committed/pushed, or whose own reclaim step
	// failed) is still swept here. Unlike base/head there can be any number of
	// these, one per conversation, so a prefix scan is needed instead of a
	// fixed pair of paths.
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
		_, _ = runGitFor(ctx, repo, "worktree", "remove", "--force", dir)
		if err := os.RemoveAll(dir); err != nil {
			return n, fmt.Errorf("remove %s: %w", dir, err)
		}
		// Best-effort: also drop the shadow's own local branch (chat/<id>),
		// otherwise it dangles in the shared clone forever for a conversation
		// that never committed/pushed, back when this branch shape existed.
		_, _ = runGitFor(ctx, repo, "branch", "-D", "chat/"+strings.TrimPrefix(e.Name(), prefix))
		n++
	}

	// Best-effort: clean up any leftover worktree admin entries in the main repo.
	_, _ = runGitFor(ctx, repo, "worktree", "prune")
	return n, nil
}

// deletePRWorkflowRuns removes every workflow run whose stored input carries
// pr — the same "pr" field RunsForPR (tasks_api.go) matches on, so a
// per-repo tracker (pr_inbox/auto_warn, no "pr" field) is never
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

// orphanRunningAge is how long a still-`running` task_code_comment run must
// sit untouched (see purgeOrphanCommentRuns's UpdatedAt check) before it's
// eligible to be purged as an orphan, even though its comment is already
// gone. A `waiting` run is purged regardless of age (see below) — a running
// one gets this grace window instead, so a run that is merely mid-Activity
// at the exact moment this pass ticks is never mistaken for a stuck orphan.
const orphanRunningAge = 24 * time.Hour

// purgeOrphanCommentRuns removes every task_code_comment run whose own
// comment no longer exists in comments.db — a run left behind after its
// comment row vanished by some other path than this workflow's own "delete"
// Signal (which itself deletes the comment AND completes the run in one go,
// see taskCodeCommentWorkflow's "delete" Action). Left alive, such an orphan
// stays `waiting` forever: every server (re)start's ResumePolling walks every
// waiting task_code_comment run and spawns a poll() goroutine per thread that
// polls GitHub forever for a comment nobody can ever act on again.
//
// The comment id and the run id are the SAME value by construction — every
// caller that mutates a comments.db row (deleteComment, markCommentDeleting,
// editCommentBody, …) keys it as `{"id": runID}` — so "does this run's
// comment still exist" is exactly `comments.Get(ctx, r.ID)`.
//
// Two run statuses are eligible, with different rules:
//   - StatusWaiting: purged unconditionally, any age. A waiting run parked on
//     WaitSignal is, by definition, not mid-flight — there is no race to
//     protect against.
//   - StatusRunning, but only once UpdatedAt is older than orphanRunningAge:
//     a run can be transiently `running` while genuinely mid-Activity (e.g.
//     the exact moment this pass ticks), so an unconditional purge here could
//     race a legitimate in-flight comment. Requiring staleness first turns
//     that race into "can only ever purge a run that's clearly stuck", at the
//     cost of leaving a genuine such orphan up to a day before it's swept —
//     an accepted trade, since the goal is bounding this to a small window,
//     not detecting it the instant it appears.
//
// A comments.Get error (a DB hiccup, not "not found") leaves the run alone —
// this pass only ever removes what it's certain about, same as
// resolveCleanupTargets. Not scoped to one PR (mirrors
// purgeRetiredWorkflowRuns) — a stray orphan can belong to any PR, merged or
// not. Uses the real wall clock (time.Now()), which is fine here: this
// function is only ever called from an Activity body, never from inside a
// Workflow function, so it is exempt from the workflow-determinism rule (see
// .claude/rules/workflow-determinism.md).
func purgeOrphanCommentRuns(ctx context.Context, engine *tembed.Engine, cm *comments.Module) (int, error) {
	if cm == nil {
		return 0, nil
	}
	runs, err := engine.Runs()
	if err != nil {
		return 0, err
	}
	now := time.Now()
	n := 0
	for _, r := range runs {
		if r.Workflow != WorkflowTaskCodeComment {
			continue
		}
		switch r.Status {
		case tembed.StatusWaiting:
			// always eligible, any age
		case tembed.StatusRunning:
			if now.Sub(r.UpdatedAt) < orphanRunningAge {
				continue // possibly still mid-Activity, too fresh to call it stuck
			}
		default:
			continue // completed/failed already terminal, nothing to clean up
		}
		_, ok, err := cm.Get(ctx, r.ID)
		if err != nil {
			continue // uncertain — don't guess, leave it for a later pass
		}
		if ok {
			continue // comment still exists, not an orphan
		}
		if err := engine.DeleteRun(r.ID); err != nil {
			return n, fmt.Errorf("delete orphan comment run %s: %w", r.ID, err)
		}
		n++
	}
	return n, nil
}

// sweptOneShotTypes are the Workflow Types whose COMPLETED one-shot runs
// carry nothing worth keeping: their whole effect lives somewhere else (the
// appended debug-log.jsonl lines; the failed runs an ignore_runs Execution
// deleted), so the run record itself is pure residue. sweepDebugLogRuns
// below removes them once they are older than debugLogRunAge.
var sweptOneShotTypes = map[string]bool{
	WorkflowDebugLog:   true,
	WorkflowIgnoreRuns: true,
}

// sweepDebugLogRuns deletes the run history of every COMPLETED one-shot of a
// sweptOneShotTypes type older than debugLogRunAge. Debug mode starts one such
// Execution per flushed batch of recorded events (see debug_log.go), and once
// it has completed the whole point of it — the appended lines — lives in
// debug-log.jsonl, which this sweep deliberately never touches. Same for an
// ignore_runs Execution: its effect is the failure it deleted. Without this
// the run table would grow for the whole length of a debugging session (or
// with every ignored failure) and never shrink.
//
// Only StatusCompleted is eligible; a Running/Waiting one-shot is either still
// in flight or a genuine failure worth keeping visible in "Mislukte taken"
// (the failed runs GET /api/problems reports are read straight from the store,
// so a failed log write is never swept here either).
//
// Uses the real wall clock (time.Now()): only ever called from an Activity
// body, exempt from the determinism rule exactly like purgeOrphanCommentRuns.
func sweepDebugLogRuns(engine *tembed.Engine) (int, error) {
	runs, err := engine.Runs()
	if err != nil {
		return 0, err
	}
	now := time.Now()
	deleted := 0
	for _, r := range runs {
		if !sweptOneShotTypes[r.Workflow] || r.Status != tembed.StatusCompleted {
			continue
		}
		if now.Sub(r.UpdatedAt) < debugLogRunAge {
			continue
		}
		if err := engine.DeleteRun(r.ID); err != nil {
			return deleted, fmt.Errorf("delete %s run %s: %w", r.Workflow, r.ID, err)
		}
		deleted++
	}
	return deleted, nil
}

// sweepTestRunResidue removes the on-disk residue any old-enough,
// COMPLETED test_run run left behind (git clean candidates recorded on its
// own Activity result, see test_run.go's testRunResult), then deletes that
// run's own history entry — nothing is left to revisit it a second time.
// Not scoped to one PR (mirrors purgeRetiredWorkflowRuns/
// purgeOrphanCommentRuns): a test run's checkout is the reviewer's own real
// local clone, not something cleanup already walks per PR.
//
// Only a run whose Status is StatusCompleted (never Running/Waiting — a
// test_run workflow is signal-less and one-shot, so those statuses mean it's
// still genuinely in flight) and whose UpdatedAt is older than
// testRunResidueAge is eligible; the age check protects a run that only just
// finished from being swept before the reviewer even had a chance to read the
// "checkout heeft resten" warning.
//
// Before removing a recorded path, this re-checks with a FRESH `git clean
// -ndx` in the same directory and only deletes the intersection: a path this
// run once flagged that is no longer flagged today (the reviewer git-added
// it, or removed it themselves) is left alone — this pass only ever removes
// what it can reconfirm right now, the same "never guess" discipline
// resolveCleanupTargets/purgeOrphanCommentRuns already follow. A directory
// that no longer exists, or is no longer a git repo, is simply skipped
// (best-effort) and its run record is still deleted — there is nothing left
// to sweep either way.
//
// Uses the real wall clock (time.Now()): only ever called from an Activity
// body, never from inside a Workflow function, so it is exempt from the
// workflow-determinism rule (see .claude/rules/workflow-determinism.md),
// exactly like purgeOrphanCommentRuns.
func sweepTestRunResidue(ctx context.Context, engine *tembed.Engine) (int, error) {
	runs, err := engine.Runs()
	if err != nil {
		return 0, err
	}
	now := time.Now()
	swept := 0
	for _, r := range runs {
		if r.Workflow != WorkflowTestRun || r.Status != tembed.StatusCompleted {
			continue
		}
		if now.Sub(r.UpdatedAt) < testRunResidueAge {
			continue // not stale enough yet — still visible as a "resten" warning
		}
		var res testRunResult
		if err := engine.Result(r.ID, &res); err != nil {
			continue // uncertain — don't guess, leave it for a later pass
		}
		if res.ResidueDir != "" && len(res.ResiduePaths) > 0 {
			removeConfirmedTestRunResidue(ctx, res.ResidueDir, res.ResiduePaths)
		}
		if err := engine.DeleteRun(r.ID); err != nil {
			return swept, fmt.Errorf("delete test_run run %s: %w", r.ID, err)
		}
		swept++
	}
	return swept, nil
}

// removeConfirmedTestRunResidue removes exactly the paths in want that a
// FRESH `git clean -ndx` in dir still reports right now — see
// sweepTestRunResidue's own doc comment for why. Best-effort throughout: a
// git failure (dir gone, no longer a repo) or an individual removal failure
// is logged and otherwise ignored, never escalated to an Activity error —
// residue cleanup must never be the reason a whole cleanup pass fails.
func removeConfirmedTestRunResidue(ctx context.Context, dir string, want []string) {
	still, err := collectTestRunResidueList(ctx, dir)
	if err != nil {
		return
	}
	stillSet := make(map[string]bool, len(still))
	for _, p := range still {
		stillSet[p] = true
	}
	for _, p := range want {
		if !stillSet[p] {
			continue
		}
		full := filepath.Join(dir, p)
		if err := os.RemoveAll(full); err != nil {
			log.Printf("cleanup: test_run residue: remove %s: %v", full, err)
		}
	}
}

// collectTestRunResidueList is the read half of test_run.go's
// collectTestRunResidue (which also caps/pairs it with a dir), factored out
// here so removeConfirmedTestRunResidue can re-run the exact same `git clean
// -ndx` parse without importing test_run.go's Activity-shaped wrapper.
func collectTestRunResidueList(ctx context.Context, dir string) ([]string, error) {
	out, err := runGitIn(ctx, dir, "clean", "-ndx")
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		path, ok := strings.CutPrefix(line, "Would remove ")
		if !ok {
			continue
		}
		if path = strings.TrimSpace(path); path != "" {
			paths = append(paths, path)
		}
	}
	return paths, nil
}
