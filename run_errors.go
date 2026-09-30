package main

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
)

// This file surfaces the two ways background work can go wrong without the
// reviewer ever noticing, and serves both to GET /api/problems (read-only) for
// the "Mislukte taken" block at the bottom of /pr-overview:
//
//   (a) a workflow run that ended in tembed.StatusFailed — durable, in the
//       tembed store, so FailedRuns below is a pure read of engine.Runs()
//       (repo-wide, unlike RunsForPR which filters on the run input's "pr");
//   (b) an error that only ever reached the log — poller/startup glue that
//       isn't a workflow run at all (e.g. "import comments: fetch review
//       comments pr=970099: ... exit status 1"). Nothing records those, so the
//       ring buffer below mirrors them.
//
// The buffer is a LOG MIRROR, not an error classifier: every TaskManager.logf
// call site reports something that was skipped, so all of them go in and none
// is judged more important than another. Purely in memory and lost on restart
// — it touches no module/read-model/workflow history, so it falls outside the
// workflows-write-boundary rule, the same carve-out as the heartbeat map and
// ingest_progress.go (see .claude/rules/workflows-write-boundary.md). Anything
// that should genuinely survive a restart would have to go through a workflow.

// problemLogCap is how many log lines the ring buffer keeps (newest wins, the
// oldest falls out). No time limit: the buffer dies with the process anyway,
// and a startup failure is exactly the thing you want to still find hours
// later.
const problemLogCap = 100

// failedRunCap is how many failed runs GET /api/problems reports (newest
// updated first).
const failedRunCap = 50

// problemWindow is how far back GET /api/problems looks. Reviewer request:
// "ik wil bovenaan van 4 dagen zien (dit mag weg zoals het nu is) en dan wil
// ik alles kunnen retrien van de laatste 4 dagen" — the earlier, unbounded
// list grew to 130 rows of weeks-old failures on PRs that were long since
// merged, which is not a list anybody acts on. Everything older is dropped
// from BOTH halves (failed runs and mirrored log lines), so the popup, the
// /pr-overview drawer and the review tree's own Taken block all agree on one
// window, and "alles opnieuw proberen" means exactly the rows on screen.
//
// The window is applied to the OUTPUT only: supersededRuns still weighs every
// run in the store, so an old successful attempt keeps hiding its failed
// predecessor.
const problemWindow = 4 * 24 * time.Hour

// LogProblem is one mirrored log line.
type LogProblem struct {
	At time.Time `json:"at"`
	// Scope is the leading "<subsystem>:" of the log line ("import comments",
	// "pr_status", "tembed", …), or "" when the line has no such prefix.
	Scope string `json:"scope"`
	// PR is the PR number parsed out of a "pr=<n>" fragment, or 0 when the line
	// names none (a repo-wide tracker, say).
	PR      int    `json:"pr"`
	Message string `json:"message"`
}

// FailedRun is one workflow run that ended in tembed.StatusFailed.
type FailedRun struct {
	RunID     string    `json:"runId"`
	Workflow  string    `json:"workflow"`
	PR        int       `json:"pr"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Error is the recorded failure message, or "" when the run's history holds
	// no readable one.
	Error string `json:"error"`
	// Comment describes WHICH comment a failed task_code_comment run was about
	// (file/line + a body snippet), parsed from the run's own immutable input —
	// the same CommentRef the "Taken" column already shows (see RunsForPR). nil
	// for every other Workflow Type. Without it a row only names the PR, and a
	// PR with a dozen failed comment threads is unreadable.
	Comment *CommentRef `json:"comment,omitempty"`
	// Retryable reports whether starting this task over actually does anything
	// (see retryableWorkflow) — the "Taken" block's row menu offers "Opnieuw
	// proberen" only then, and says so instead of pretending otherwise.
	Retryable bool `json:"retryable"`
}

// retryableWorkflow answers "can this failed run be retried at all?" — the
// gate behind RetryRun and the Retryable field above.
//
// Since RetryRun RESUMES a failed run in place (see Engine.ResumeFailed) rather
// than starting a fresh Execution, a per-item deterministic Run ID
// (perItemRunID) is no longer an obstacle: there is nothing to start, the very
// same run is driven on from its last successful step. That is what made the
// bulk of the list — the failed comment threads — retryable at all.
//
// One kind is still excluded, and for it a retry would be a lie rather than a
// failure: a retired Workflow Type (retiredWorkflowTypes, cleanup.go). Its
// registering code is gone, so the engine has no function to replay against.
func retryableWorkflow(workflow string) bool {
	return workflow != "" && !retiredWorkflowTypes[workflow]
}

// RetryRun resumes the failed run FROM ITS LAST SUCCESSFUL STEP and returns
// its Run ID (the same one — there is no new run). Reviewer request: "ook
// alles retryen vanaf de laatste keer dat dezelfde taak goed is gegaan".
//
// It used to start a fresh Execution with the run's stored input. Two problems
// with that, both fixed by resuming instead:
//
//   - work that already succeeded was redone from scratch, so a task that
//     failed on its last step repeated every step before it;
//   - for a per-item deterministic Run ID (perItemRunID) — the failed comment
//     threads, i.e. most of the list — starting over was an idempotent no-op
//     that returned the very same failed run, so those rows could not be
//     retried at all.
//
// Engine.ResumeFailedInBackground cuts the failure tail off the run's history,
// puts it back to `running` and advances it in the background, so replay reuses every recorded activity result
// and only the step that failed runs live again. That step must be idempotent,
// which is the standing assumption for every Activity anyway.
//
// This is a write, and it is the sanctioned kind: driving a workflow Execution
// is exactly what .claude/rules/workflows-write-boundary.md allows an endpoint
// to do — the run's own Activities still do every actual mutation.
func (m *TaskManager) RetryRun(runID string) (string, error) {
	runs, err := m.engine.Runs()
	if err != nil {
		return "", err
	}
	var rec *tembed.RunRecord
	for i := range runs {
		if runs[i].ID == runID {
			rec = &runs[i]
			break
		}
	}
	if rec == nil {
		return "", fmt.Errorf("retry: unknown run %q", runID)
	}
	if rec.Status != tembed.StatusFailed {
		return "", fmt.Errorf("retry: run %q is %s, not failed", runID, rec.Status)
	}
	if !retryableWorkflow(rec.Workflow) {
		return "", fmt.Errorf("retry: workflow %q cannot be retried", rec.Workflow)
	}
	if _, errs := m.engine.ResumeFailedInBackground([]string{runID}); errs[runID] != nil {
		return "", fmt.Errorf("retry: %w", errs[runID])
	}
	return runID, nil
}

// RetryAllFailed retries every failure currently on the list — i.e. exactly
// the rows GET /api/problems shows, so within problemWindow — and reports how
// many were resumed and how many could not be (a retired Workflow Type, or a
// run the engine refused to resume). Behind the "Alles opnieuw proberen"
// button of the global failed-tasks popup.
//
// Both RetryRun and this return as soon as the runs are PREPARED (failure tail
// cut, status back to `running`); the engine drives them on in the background,
// one after another — see Engine.ResumeFailedInBackground for why neither
// inline (the button spun for as long as the post-restart LLM backlog took)
// nor all at once (the SQLITE_BUSY storm that produced most of these failures
// in the first place).
func (m *TaskManager) RetryAllFailed() (retried int, skipped int) {
	var ids []string
	for _, f := range m.FailedRuns(0) {
		if !f.Retryable {
			skipped++
			continue
		}
		ids = append(ids, f.RunID)
	}
	resumed, errs := m.engine.ResumeFailedInBackground(ids)
	for _, id := range ids {
		if err := errs[id]; err != nil {
			m.logf("retry all: run %s: %v", id, err)
		}
	}
	return len(resumed), skipped + len(errs)
}

// perItemRunID lists the Workflow Types started through StartWorkflowID with a
// per-ITEM deterministic Run ID (a comment id, a call/explain key, a chat
// conversation, the per-PR chat-merge queue). Two things follow, and both
// matter for supersededRuns below:
//
//   - Their identity is the Run ID itself, never workflow+pr — a PR has many
//     comment threads, so a succeeded one must never hide a failed sibling.
//   - A retry is structurally impossible: startWorkflowID is idempotent, so
//     starting the same ID again is a no-op that returns the very same failed
//     run. Such a failure is permanently open work and must keep showing.
//
// Deliberately a hand-maintained list (like retiredWorkflowTypes): add a name
// here when a new workflow starts using a deterministic Run ID.
var perItemRunID = map[string]bool{
	WorkflowTaskCodeComment: true, // importedRunID(rootID) / the comment id
	WorkflowResolveCall:     true, // resolveCallRunID(in)
	WorkflowExplainCode:     true, // explainRunID(in)
	WorkflowClaudeChat:      true, // the conversation id
	WorkflowChatMerge:       true, // chatMergeQueueRunID(pr)
	WorkflowSummarizeChat:   true, // chatSummaryRunID(commentID, msgCount)
	WorkflowCommentTitles:   true, // commentTitlesRunID(pr, items)
}

// runIdentity answers "which task is this run an attempt at?" — the key
// supersededRuns groups on. Ordinarily workflow+pr, which is exactly what the
// app itself already treats as one task (findPRStatusLocked looks for "a
// pr_status run for this PR"); pr 0 covers the repo-wide trackers and the
// nightly cleanup pass. See perItemRunID for the exception.
func runIdentity(workflow, runID string, pr int) string {
	if perItemRunID[workflow] {
		return "run#" + runID
	}
	return workflow + "#" + strconv.Itoa(pr)
}

var (
	problemMu  sync.Mutex
	problemLog []LogProblem // oldest first, capped at problemLogCap
)

// rePRField finds the "pr=<n>" fragment every PR-scoped log line carries.
var rePRField = regexp.MustCompile(`\bpr=(\d+)`)

// recordProblem appends one already-formatted log line to the ring buffer.
func recordProblem(msg string) {
	msg = strings.TrimSpace(msg)
	if msg == "" {
		return
	}
	p := LogProblem{At: time.Now(), Scope: problemScope(msg), Message: msg}
	if m := rePRField.FindStringSubmatch(msg); m != nil {
		p.PR, _ = strconv.Atoi(m[1])
	}
	problemMu.Lock()
	defer problemMu.Unlock()
	problemLog = append(problemLog, p)
	if len(problemLog) > problemLogCap {
		problemLog = problemLog[len(problemLog)-problemLogCap:]
	}
}

// problemScope returns the subsystem prefix before the first ":" — but only
// when it really looks like one (short, no "=" in it), so a colon inside a
// plain sentence never becomes a scope.
func problemScope(msg string) string {
	i := strings.IndexByte(msg, ':')
	if i <= 0 || i > 40 {
		return ""
	}
	head := msg[:i]
	if strings.ContainsAny(head, "=") {
		return ""
	}
	return head
}

// loggedProblems returns the mirrored log lines from the last problemWindow,
// newest first. Older lines stay in the buffer (they cost nothing and a
// startup failure is still worth finding), they just don't reach the UI.
func loggedProblems() []LogProblem {
	cutoff := time.Now().Add(-problemWindow)
	problemMu.Lock()
	defer problemMu.Unlock()
	out := make([]LogProblem, 0, len(problemLog))
	for i := len(problemLog) - 1; i >= 0; i-- {
		if problemLog[i].At.Before(cutoff) {
			continue
		}
		out = append(out, problemLog[i])
	}
	return out
}

// resetProblemLog clears the buffer (tests only).
func resetProblemLog() {
	problemMu.Lock()
	defer problemMu.Unlock()
	problemLog = nil
}

// mirrorManagerLogs wraps m's log function so every line it writes also lands
// in the buffer. m.logf is the single funnel every glue-level error in
// workflows.go already goes through (~40 call sites), so this one wrapper
// covers them all — no per-site change, and a new call site is mirrored for
// free.
func mirrorManagerLogs(m *TaskManager) {
	base := m.logf
	if base == nil {
		base = log.Printf
	}
	m.logf = func(format string, args ...any) {
		base(format, args...)
		recordProblem(fmt.Sprintf(format, args...))
	}
}

// problemMirrorLogger is the same mirror for the tembed engine's own log lines
// (e.g. "run X uses unregistered workflow", which only ever appear at
// startup/recovery).
func problemMirrorLogger() tembed.Option {
	return tembed.WithLogger(func(format string, args ...any) {
		log.Printf(format, args...)
		recordProblem(fmt.Sprintf(format, args...))
	})
}

// runPR parses the "pr" field out of a run's stored input — the same field
// RunsForPR matches on. 0 when the input names none (a repo-wide tracker).
func (m *TaskManager) runPR(runID string) int {
	in, err := m.engine.Input(runID)
	if err != nil {
		return 0
	}
	var input struct {
		PR int `json:"pr"`
	}
	if json.Unmarshal(in, &input) != nil {
		return 0
	}
	return input.PR
}

// supersededRuns maps each run identity (see runIdentity) to the newest
// CreatedAt of a run that is NOT failed. A failed run created before that time
// was superseded: the same task was started again and either completed or is
// still alive, so it is no longer something the reviewer has to act on.
//
// running/waiting count too, deliberately: a pr_status tracker stays `waiting`
// forever and never reaches `completed`, so without them the single most common
// case — findPRStatusLocked starting a fresh tracker after one failed — would
// never clear. Another `failed` run never supersedes anything.
//
// CreatedAt, not UpdatedAt: a long-lived tracker's UpdatedAt keeps moving, which
// would hide a failure that happened after that tracker started.
func supersededRuns(runs []tembed.RunRecord, prOf func(string) int) map[string]time.Time {
	alive := map[string]time.Time{}
	for _, r := range runs {
		if r.Status == tembed.StatusFailed {
			continue
		}
		k := runIdentity(r.Workflow, r.ID, prOf(r.ID))
		if t, ok := alive[k]; !ok || r.CreatedAt.After(t) {
			alive[k] = r.CreatedAt
		}
	}
	return alive
}

// FailedRuns lists, newest-updated first, up to limit workflow runs (limit <= 0
// means all of them) that failed within the last problemWindow, ended in
// tembed.StatusFailed and have NOT been superseded by a later attempt at the
// same task (see supersededRuns) — repo-wide, so a per-repo tracker (no "pr" in
// its input, hence PR 0) is included too. Read-only: it only inspects
// engine.Runs()/Input()/Result(), it never starts, signals, or deletes
// anything; the superseded run itself stays in the tembed store (cleanup
// removes it once its PR is merged and old, see cleanup.go).
func (m *TaskManager) FailedRuns(limit int) []FailedRun {
	runs, err := m.engine.Runs()
	if err != nil {
		return nil
	}
	// One input parse per run, memoized, so the identity pass below and the
	// per-row PR both read the same value without a second store call.
	prCache := map[string]int{}
	prOf := func(runID string) int {
		if pr, ok := prCache[runID]; ok {
			return pr
		}
		pr := m.runPR(runID)
		prCache[runID] = pr
		return pr
	}
	alive := supersededRuns(runs, prOf)

	cutoff := time.Now().Add(-problemWindow)
	out := make([]FailedRun, 0, len(runs))
	for _, r := range runs {
		if r.Status != tembed.StatusFailed {
			continue
		}
		if r.UpdatedAt.Before(cutoff) {
			continue // older than problemWindow — not a list anybody acts on
		}
		pr := prOf(r.ID)
		if t, ok := alive[runIdentity(r.Workflow, r.ID, pr)]; ok && t.After(r.CreatedAt) {
			continue // a later attempt at the same task took over
		}
		f := FailedRun{RunID: r.ID, Workflow: r.Workflow, PR: pr, UpdatedAt: r.UpdatedAt, Retryable: retryableWorkflow(r.Workflow)}
		if r.Workflow == WorkflowTaskCodeComment {
			if in, err := m.engine.Input(r.ID); err == nil {
				var cc CodeCommentInput
				if json.Unmarshal(in, &cc) == nil && cc.File != "" {
					f.Comment = &CommentRef{
						File: cc.File, Label: cc.Label, Gran: cc.Gran, Line: cc.Line,
						RowStart: cc.RowStart, RowEnd: cc.RowEnd,
						Snippet: commentSnippet(cc.Body, 60),
					}
				}
			}
		}
		// Result reports a failed run as an error carrying the recorded
		// failure message — the only readable form of it.
		if err := m.engine.Result(r.ID, nil); err != nil {
			f.Error = err.Error()
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// RunningCounts is "how much is genuinely busy right now" — repo-wide (total)
// and per PR (byPR, keyed by statusKey so it matches the overview's prUid).
// Feeds the header badge and the per-row "N bezig" chip on /pr-overview.
// Read-only, same shape as FailedRuns.
//
// Two sources, deliberately combined:
//   - workflow runs in tembed.StatusRunning — NOT StatusWaiting, which is what a
//     long-lived tracker (pr_status, approve, …) sits in between actual steps.
//     StatusRunning is the narrow window a run spends executing an Activity.
//   - claude_chat turns that are really doing something (chatProgressByConv,
//     chat_progress.go). A turn signalled into a waiting claude_chat run runs
//     inline while the run stays StatusWaiting, so the status alone never saw
//     an active chat. claude_chat runs are therefore skipped in the status
//     count and counted only through the progress map, so a first turn (whose
//     run IS briefly StatusRunning) is not counted twice. Plan-page turns
//     (pr 0) are left out: they belong to no PR.
func (m *TaskManager) RunningCounts() (total int, byPR map[string]int) {
	var busy []activeUnit
	if runs, err := m.engine.Runs(); err == nil {
		for _, r := range runs {
			if r.Status != tembed.StatusRunning || r.Workflow == WorkflowClaudeChat {
				continue
			}
			u := activeUnit{}
			if in, err := m.engine.Input(r.ID); err == nil {
				var input struct {
					Repo string `json:"repo"`
					PR   int    `json:"pr"`
				}
				if json.Unmarshal(in, &input) == nil {
					u.repo, u.pr = input.Repo, input.PR
				}
			}
			busy = append(busy, u)
		}
	}
	busy = append(busy, runningChatTurns()...)
	return countActive(busy)
}

// activeUnit is one busy thing (a running run or an active chat turn) and the
// PR it belongs to (pr 0 = repo-wide, counted only in the total).
type activeUnit struct {
	repo string
	pr   int
}

// countActive is RunningCounts' pure tally, split out so it is testable
// without driving a real run into StatusRunning.
func countActive(units []activeUnit) (int, map[string]int) {
	byPR := map[string]int{}
	for _, u := range units {
		if u.pr > 0 {
			byPR[statusKey(canonRepo(u.repo), u.pr)]++
		}
	}
	return len(units), byPR
}
