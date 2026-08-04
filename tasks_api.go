package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/autowarn"
	"slash/modules/callresolve"
	"slash/modules/chat"
	"slash/modules/claude"
	"slash/modules/commentignore"
	"slash/modules/comments"
	"slash/modules/explanations"
	"slash/modules/github"
	"slash/modules/inbox"
	"slash/modules/jira"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/reviewerusage"
	"slash/modules/taskinbox"
	"slash/modules/tasksnooze"
	"slash/modules/testcovers"
	"slash/modules/warnrevoke"
)

// tasks holds the workflow engine + the module read sides. It is built once at
// server start.
type tasks struct {
	engine        *tembed.Engine
	manager       *TaskManager
	comments      *comments.Module
	inbox         *inbox.Module
	relations     *relations.Module
	prmeta        *prmeta.Module
	callresolve   *callresolve.Module
	testcovers    *testcovers.Module
	approvals     *approvals.Module
	explain       *explanations.Module
	reviewerusage *reviewerusage.Module
	tasksnooze    *tasksnooze.Module
	commentignore *commentignore.Module
	taskinbox     *taskinbox.Module
	chat          *chat.Module
}

// newTasks builds the tembed engine (SQLite + JSONL, so comments live in the
// workflow event history AND in jsonl files), the comments module, and the
// github module, then recovers in-flight executions and resumes their pollers.
// resumeRuntime gates the server-only runtime bits (resuming comment pollers,
// ensuring the inbox tracker + its poller) — a one-shot CLI caller (e.g. `slash
// ingest`) passes false so it doesn't start background pollers or fetch the
// inbox just to run a single workflow.
func newTasks(ctx context.Context, db *sql.DB, dataDir, repo string, resumeRuntime bool) (*tasks, func() error, error) {
	sq, err := tembed.NewSQLiteStore(dataDir + "/workflows.db")
	if err != nil {
		return nil, nil, err
	}
	jl, err := tembed.NewJSONLStore(dataDir + "/workflows")
	if err != nil {
		sq.Close()
		return nil, nil, err
	}
	// The engine's own log lines (e.g. an unregistered workflow found during
	// recovery) are mirrored into the in-memory problem buffer so they reach
	// GET /api/problems instead of only the terminal — see run_errors.go.
	engine := tembed.New(tembed.NewMultiStore(sq, jl), problemMirrorLogger())

	cs, err := comments.Open(dataDir + "/comments.db")
	if err != nil {
		sq.Close()
		return nil, nil, err
	}
	ib, err := inbox.Open(dataDir + "/inbox.db")
	if err != nil {
		sq.Close()
		cs.Close()
		return nil, nil, err
	}
	rel, err := relations.Open(dataDir + "/relations.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		return nil, nil, err
	}
	pm, err := prmeta.Open(dataDir + "/prmeta.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		return nil, nil, err
	}
	cr, err := callresolve.Open(dataDir + "/callresolve.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		return nil, nil, err
	}
	tc, err := testcovers.Open(dataDir + "/testcovers.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		return nil, nil, err
	}
	ap, err := approvals.Open(dataDir + "/approvals.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		return nil, nil, err
	}
	ex, err := explanations.Open(dataDir + "/explanations.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		return nil, nil, err
	}
	ru, err := reviewerusage.Open(dataDir + "/reviewerusage.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		ex.Close()
		return nil, nil, err
	}
	ts, err := tasksnooze.Open(dataDir + "/tasksnooze.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		ex.Close()
		ru.Close()
		return nil, nil, err
	}
	ci, err := commentignore.Open(dataDir + "/commentignore.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		ex.Close()
		ru.Close()
		ts.Close()
		return nil, nil, err
	}
	ti, err := taskinbox.Open(dataDir + "/taskinbox.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		ex.Close()
		ru.Close()
		ts.Close()
		ci.Close()
		return nil, nil, err
	}
	ch, err := chat.Open(dataDir + "/chat.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		ex.Close()
		ru.Close()
		ts.Close()
		ci.Close()
		ti.Close()
		return nil, nil, err
	}
	aw, err := autowarn.Open(dataDir + "/autowarn.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		ex.Close()
		ru.Close()
		ts.Close()
		ci.Close()
		ti.Close()
		ch.Close()
		return nil, nil, err
	}
	wr, err := warnrevoke.Open(dataDir + "/warnrevoke.db")
	if err != nil {
		sq.Close()
		cs.Close()
		ib.Close()
		rel.Close()
		pm.Close()
		cr.Close()
		tc.Close()
		ap.Close()
		ex.Close()
		ru.Close()
		ts.Close()
		ci.Close()
		ti.Close()
		ch.Close()
		aw.Close()
		return nil, nil, err
	}

	// Under test (SLASH_GITHUB=off) use a no-network Fake so runs never touch a
	// real repo; otherwise talk to GitHub via gh.
	var gh github.Client = github.New(repo)
	if os.Getenv("SLASH_GITHUB") == "off" {
		gh = &github.Fake{}
	}
	// Under SLASH_CLAUDE=off the LLM resolver never shells out — an empty Fake
	// resolves nothing (offline/tests). Otherwise use the real claude CLI, with
	// a scratch cwd reserved for its context-only runs — see modules/claude's
	// Module.scratchDir doc. Deliberately anchored under os.TempDir(), NOT
	// under dataDir: `claude` walks *up* the directory tree from its cwd
	// looking for a CLAUDE.md (like git looks for .git), so anything nested
	// inside this repo (dataDir is normally "data/" under the repo root)
	// would still find and load this project's own CLAUDE.md/.claude/rules —
	// confirmed empirically, see the resolve_call section of
	// .claude/docs/tembed-workflows.md.
	var cl claude.Client = claude.New(filepath.Join(os.TempDir(), "slash-llm-cwd"))
	if os.Getenv("SLASH_CLAUDE") == "off" {
		fake := claude.NewFake()
		// SLASH_CLAUDE_CHAT_TURNS optionally points at a JSON fixture
		// ([]string) that programs the Fake's RunChat replies deterministically
		// — mirrors SLASH_JIRA_ASSIGNED below. Needed so a Playwright spec can
		// exercise the embedded Claude chat's "question with choices" turn
		// end-to-end (see the "Embedded Claude chat" section of
		// comments-panel.md): without it every RunChat call returns "" (see
		// Fake.RunChat's own doc comment).
		if path := os.Getenv("SLASH_CLAUDE_CHAT_TURNS"); path != "" {
			if raw, err := os.ReadFile(path); err == nil {
				var turns []string
				if json.Unmarshal(raw, &turns) == nil {
					fake.SetChatTurns(turns...)
				}
			}
		}
		cl = fake
	}
	// Under SLASH_JIRA=off the Jira bridge never shells out (offline/tests): an
	// empty Fake reports no linked issue for every key. SLASH_JIRA_ASSIGNED
	// optionally points at a JSON fixture ([]jira.Issue) that seeds the Fake's
	// AssignedToMe result deterministically — mirrors SLASH_INBOX for the
	// task_inbox workflow's "jira" task source (see
	// .claude/docs/tembed-workflows.md, task_inbox).
	var jr jira.Client = jira.New()
	if os.Getenv("SLASH_JIRA") == "off" {
		fake := &jira.Fake{}
		if path := os.Getenv("SLASH_JIRA_ASSIGNED"); path != "" {
			if raw, err := os.ReadFile(path); err == nil {
				var issues []jira.Issue
				if json.Unmarshal(raw, &issues) == nil {
					fake.SetAssigned(issues)
				}
			}
		}
		jr = fake
	}
	mgr := NewTaskManager(engine, gh, cs, ib, rel, pm, cr, tc, ap, ex, ts, cl, jr, db, dataDir, repo)
	// Set post-construction (not a constructor param) so every existing
	// NewTaskManager test call site stays unchanged; a nil store just makes
	// bumpReviewerUsage a no-op.
	mgr.reviewerusage = ru
	// Same pattern for the task-inbox read-model: a nil store makes
	// refreshTasks a no-op.
	mgr.taskinbox = ti
	// Same pattern for the ignore-comment read-model: a nil store makes
	// saveCommentIgnore a no-op.
	mgr.commentignore = ci
	// Same pattern for the chat read-model: a nil store makes the chat
	// Activities (ensureChatConversation/saveChatMessage/saveChatAnswer/
	// runClaudeTurn) no-ops.
	mgr.chat = ch
	// Same pattern for the auto-warn preference: a nil store makes
	// AutoWarnEnabled report "enabled" (the default) and saveAutoWarnEnabled a
	// no-op.
	mgr.autowarn = aw
	// Same pattern for the warning-revocation bookkeeping: a nil store makes
	// markWarningRevocation always report "new" (never suppresses a revoke).
	mgr.warnrevoke = wr
	// Mirror every glue-level log line (poller/startup errors that are not a
	// workflow run of their own) into the in-memory problem buffer behind
	// GET /api/problems — see run_errors.go.
	mirrorManagerLogs(mgr)
	// Record the server-lifetime context + whether background pollers may run,
	// so ensurePRStatus's fresh-poller spawn uses a context that outlives the
	// HTTP request that triggered it (see TaskManager.baseCtx).
	mgr.SetRuntime(ctx, resumeRuntime)

	if err := engine.Recover(); err != nil {
		return nil, nil, err
	}
	if resumeRuntime {
		mgr.ResumePolling(ctx)
		// Resume the ingest-refresh poller for every pr_status tracker that was
		// already running before this restart (mirrors ResumePolling).
		mgr.ResumePRStatusPolling(ctx)
		// Own the PR inbox via the workflow: fetch an initial snapshot into the
		// read-model and start the refresh poller (the UI reads only the read-model).
		mgr.EnsureInbox(ctx)
		// Own the per-repo task-snooze tracker so the UI has a Run ID to signal
		// snooze/un-snooze to (no poller — it only reacts to UI signals).
		if _, err := mgr.EnsureTaskSnooze(); err != nil {
			mgr.logf("tasksnooze: ensure: %v", err)
		}
		// Own the per-repo auto-warn tracker so the toggle next to the theme
		// button has a Run ID to signal to (no poller — it only reacts to UI
		// signals).
		if _, err := mgr.EnsureAutoWarn(); err != nil {
			mgr.logf("autowarn: ensure: %v", err)
		}
		// Own the task inbox via the workflow: aggregate an initial snapshot
		// into the read-model and start the refresh poller (the UI reads only
		// the read-model). Mirrors EnsureInbox.
		mgr.EnsureTaskInbox(ctx)
		// Daily maintenance: purge all data of PRs merged more than
		// cleanupMergedAge ago. See StartCleanupScheduler for why this is a
		// plain background ticker rather than a durable in-workflow loop.
		mgr.StartCleanupScheduler(ctx)
	}

	closeFn := func() error {
		_ = sq.Close()
		_ = ib.Close()
		_ = rel.Close()
		_ = pm.Close()
		_ = cr.Close()
		_ = tc.Close()
		_ = ap.Close()
		_ = ex.Close()
		_ = ru.Close()
		_ = ts.Close()
		_ = ti.Close()
		_ = ci.Close()
		_ = ch.Close()
		_ = aw.Close()
		_ = wr.Close()
		return cs.Close()
	}
	return &tasks{engine: engine, manager: mgr, comments: cs, inbox: ib, relations: rel, prmeta: pm, callresolve: cr, testcovers: tc, approvals: ap, explain: ex, reviewerusage: ru, tasksnooze: ts, taskinbox: ti, commentignore: ci, chat: ch}, closeFn, nil
}

// ResumePolling restarts the GitHub poller for every waiting code-comment
// execution after a restart (so the "check GitHub every minute" keeps running).
func (m *TaskManager) ResumePolling(ctx context.Context) {
	runs, err := m.engine.Runs()
	if err != nil {
		m.logf("task_code_comment: resume polling: %v", err)
		return
	}
	for _, r := range runs {
		if r.Workflow != WorkflowTaskCodeComment || r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input CodeCommentInput
		if json.Unmarshal(in, &input) != nil {
			continue
		}
		// An imported thread's root ID lives in its input, not in a
		// postGithubComment history event (it was never posted), so prefer that.
		rootID := input.ImportedRootID
		if rootID == 0 {
			rootID, _ = m.rootID(r.ID)
		}
		if rootID != 0 {
			prRunID, err := m.ensurePRStatus(input.PR)
			if err != nil {
				m.logf("task_code_comment: resume ensure pr_status pr=%d: %v", input.PR, err)
				prRunID = ""
			}
			// Mark imported threads as polled so a concurrent importPRComments
			// tick doesn't start a second poller for the same run.
			if input.ImportedRootID != 0 {
				m.mu.Lock()
				m.importPolled[r.ID] = true
				m.mu.Unlock()
			}
			go m.poll(ctx, r.ID, input.PR, rootID, prRunID)
		}
	}
}

// ResumePRStatusPolling restarts the ingest-refresh poller for every waiting
// pr_status execution after a restart (mirrors ResumePolling for comment
// threads), so the "check the PR's head SHA" poll keeps running across a
// server restart.
func (m *TaskManager) ResumePRStatusPolling(ctx context.Context) {
	runs, err := m.engine.Runs()
	if err != nil {
		m.logf("pr_status: resume polling: %v", err)
		return
	}
	for _, r := range runs {
		if r.Workflow != WorkflowPRStatus || r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input PRStatusInput
		if json.Unmarshal(in, &input) != nil || input.PR == 0 {
			continue
		}
		m.mu.Lock()
		m.prRuns[input.PR] = r.ID
		m.mu.Unlock()
		go m.pollIngestRefresh(ctx, r.ID, input.PR)
		// Resume importing/polling this PR's GitHub comments too (mirrors the
		// fresh-tracker spawn in ensurePRStatus).
		go m.pollImportComments(ctx, r.ID, input.PR)
	}
}

// cleanupScheduleInterval is how often the cleanup workflow is triggered
// automatically once the server is running (see StartCleanupScheduler).
const cleanupScheduleInterval = 24 * time.Hour

// StartCleanupScheduler starts the daily-maintenance background loop: an
// immediate cleanup pass, then one more every cleanupScheduleInterval, for as
// long as ctx lives. Running an extra pass (e.g. right after every server
// restart) is harmless — resolveCleanupTargets/purgePR are idempotent, a PR
// with no remaining data simply isn't a candidate anymore.
//
// This is a plain background goroutine — the same "operational, no durable
// state of its own" shape as pollInbox/pollIngestRefresh/pollImportComments —
// rather than a durable w.Sleep loop inside the cleanup workflow itself.
// Unlike those pollers, cleanup has no reviewer-driven heartbeat concept: it's
// unconditional daily maintenance, not something a user is "actively
// viewing", so the fast/slow cadence machinery those pollers use doesn't
// apply here — a plain fixed-interval ticker is the simplest fit. Keeping the
// scheduling outside the `cleanup` Workflow Type itself also keeps that
// workflow a short, one-shot, signal-less run (mirroring ingest/
// submit_review) instead of an unusual infinite-loop workflow that never
// completes and would otherwise sit permanently "waiting" in
// GET /api/workflows.
func (m *TaskManager) StartCleanupScheduler(ctx context.Context) {
	go func() {
		m.runCleanupOnce(ctx)
		ticker := time.NewTicker(cleanupScheduleInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.runCleanupOnce(ctx)
			}
		}
	}()
}

// runCleanupOnce runs one cleanup pass and logs the outcome (or failure) —
// shared by the initial kick-off and every subsequent tick.
func (m *TaskManager) runCleanupOnce(ctx context.Context) {
	res, err := m.StartCleanup(ctx)
	if err != nil {
		m.logf("cleanup: run failed: %v", err)
		return
	}
	m.logf("cleanup: purged %d pr(s) (cutoff=%s)", len(res.Purged), res.Cutoff.Format(time.RFC3339))
}

// WorkflowRunView is one row of the read-only "Taken" (tasks) list: a workflow
// run scoped to a single PR, with a JSON-friendly shape (camelCase, string
// status/time).
type WorkflowRunView struct {
	RunID     string      `json:"runId"`
	Workflow  string      `json:"workflow"`
	Status    string      `json:"status"`
	CreatedAt time.Time   `json:"createdAt"`
	UpdatedAt time.Time   `json:"updatedAt"`
	Comment   *CommentRef `json:"comment,omitempty"`
	// WarningsFound is the number of findings a completed code_warning run
	// produced (from its own recorded Result — see codeWarningWorkflow), so
	// the "Taken" column can say "geen risico's gevonden" instead of a
	// generic status word. nil for every other run, and for a code_warning
	// run that hasn't completed yet.
	WarningsFound *int `json:"warningsFound,omitempty"`
}

// CommentRef is the nested code-comment reference on a task_code_comment run's
// WorkflowRunView row — parsed from the run's own (immutable) input — so the
// "Taken" column can describe what the comment is about and the UI can select
// + scroll to it. RunID (== the comment's id) already sits on the outer view.
type CommentRef struct {
	File     string `json:"file"`
	Label    string `json:"label"`
	Gran     string `json:"gran"`
	Line     int    `json:"line"`
	RowStart int    `json:"rowStart"`
	RowEnd   int    `json:"rowEnd"`
	Snippet  string `json:"snippet"`
}

// commentSnippet trims body to roughly n characters on a word boundary, adding
// an ellipsis when it truncated — a short preview for the "Taken" row.
func commentSnippet(body string, n int) string {
	body = strings.TrimSpace(body)
	if len(body) <= n {
		return body
	}
	cut := body[:n]
	if i := strings.LastIndexAny(cut, " \t\n"); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut) + "…"
}

// RunsForPR lists every workflow run whose input carries the given PR number,
// newest-updated first. Read-only: it only inspects engine.Runs()/Input(), it
// never signals or starts anything. pr_inbox runs are per-repo (no "pr" field
// in their input) so they never match and are correctly excluded.
func (m *TaskManager) RunsForPR(pr int) []WorkflowRunView {
	runs, err := m.engine.Runs()
	if err != nil {
		return nil
	}
	out := make([]WorkflowRunView, 0, len(runs))
	for _, r := range runs {
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input struct {
			PR int `json:"pr"`
		}
		if json.Unmarshal(in, &input) != nil || input.PR != pr {
			continue
		}
		view := WorkflowRunView{
			RunID: r.ID, Workflow: r.Workflow, Status: r.Status,
			CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		}
		if r.Workflow == WorkflowTaskCodeComment {
			var cc CodeCommentInput
			if json.Unmarshal(in, &cc) == nil && cc.File != "" {
				view.Comment = &CommentRef{
					File: cc.File, Label: cc.Label, Gran: cc.Gran, Line: cc.Line,
					RowStart: cc.RowStart, RowEnd: cc.RowEnd,
					Snippet: commentSnippet(cc.Body, 60),
				}
			}
		}
		if r.Workflow == WorkflowCodeWarning && r.Status == tembed.StatusCompleted {
			var res struct {
				Found int `json:"found"`
			}
			if m.engine.Result(r.ID, &res) == nil {
				n := res.Found
				view.WarningsFound = &n
			}
		}
		out = append(out, view)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out
}

// routesTasks registers the workflow + comments routes on mux. Writes go only
// through workflow endpoints (start / signal); everything else is read-only.
func (s *server) routesTasks(mux *http.ServeMux) {
	// POST /api/workflows/task_code_comment            → start an execution
	// GET  /api/workflows/task_code_comment            → list executions
	// POST /api/workflows/{runID}/signals/{signalName} → signal (UI reaction)
	// GET  /api/workflows/{runID}                       → execution status
	mux.HandleFunc("/api/workflows/", s.handleWorkflows)
	mux.HandleFunc("/api/workflows/task_code_comment", s.handleTaskCodeComment)
	// GET /api/workflows?pr=N → read-only list of workflow runs for one PR (the
	// "Taken" column in RelatedPanel): status per run, newest first.
	mux.HandleFunc("/api/workflows", s.handleWorkflowsList)
	// POST /api/workflows/resolve_call → start an LLM call-resolution execution
	mux.HandleFunc("/api/workflows/resolve_call", s.handleResolveCall)
	// POST /api/workflows/resolve_test_covers → start an LLM test-coverage
	// resolution execution (class-level-only annotations only).
	mux.HandleFunc("/api/workflows/resolve_test_covers", s.handleResolveTestCovers)
	// POST /api/workflows/explain_code → start (idempotently, via a
	// deterministic Run ID) an AI-explanation execution for one navigation unit
	// containing an if-statement (the footer description).
	mux.HandleFunc("/api/workflows/explain_code", s.handleExplainCode)
	// POST /api/workflows/pr_status {pr} → ensure the per-PR lifecycle tracker
	// (its start fetches the PR's metadata into the prmeta read-model).
	mux.HandleFunc("/api/workflows/pr_status", s.handlePRStatusStart)
	// POST /api/workflows/approve {pr} → ensure the per-PR approval tracker; the
	// UI then signals approvals to its Run ID via .../signals/set.
	mux.HandleFunc("/api/workflows/approve", s.handleApproveStart)
	// POST /api/workflows/submit_review {pr,event,body?} → submit a real GitHub
	// PR-level review (approve or request changes). One Execution per submit.
	mux.HandleFunc("/api/workflows/submit_review", s.handleSubmitReview)
	// POST /api/workflows/ready_for_review {pr,reviewers?} → flip a draft PR to
	// ready + request reviewers. GET /api/reviewers → candidate reviewers
	// (repo collaborators), most-used-first (read-only).
	mux.HandleFunc("/api/workflows/ready_for_review", s.handleReadyForReview)
	mux.HandleFunc("/api/reviewers", s.handleReviewers)
	// GET /api/me → read-only: the authenticated GitHub user (login + avatar),
	// so the UI can show who "I" am on the comments/replies written in this app
	// (they carry no GitHub author of their own). See handleMe.
	mux.HandleFunc("/api/me", s.handleMe)
	// GET /api/names?logins=a,b,c → read-only: the human name + avatar behind a
	// GitHub login, so the UI can show "Dennis" instead of "dennissloove". See
	// handleNames / usernames.go.
	mux.HandleFunc("/api/names", s.handleNames)
	// GET /api/settings → read-only: the local, per-reviewer settings file
	// (<dataDir>/settings.json, gitignored). Today only "who am I" for @mention
	// detection, which OVERRIDES the login /api/me reports. See settings.go.
	mux.HandleFunc("/api/settings", s.handleSettings)
	// POST /api/workflows/code_warning {pr} → start an agentic Opus review of
	// the whole PR for risks (the "/" menu's "Diepgravend onderzoek"). One
	// Execution per manual run.
	mux.HandleFunc("/api/workflows/code_warning", s.handleCodeWarning)
	// GET /api/approvals?pr=N → read-only approval read-model (per block: the
	// approved changed rows + call segments) for refresh-restore.
	mux.HandleFunc("/api/approvals", s.handleApprovals)
	// POST /api/workflows/ignore_comment {pr} → ensure the per-PR
	// ignore-comment tracker; the UI then signals ignore/un-ignore to its Run
	// ID via .../signals/ignore.
	mux.HandleFunc("/api/workflows/ignore_comment", s.handleIgnoreCommentStart)
	// GET /api/commentignores?pr=N → read-only ignore-comment read-model (which
	// PR-wide comments are hidden from the block index) for refresh-restore.
	mux.HandleFunc("/api/commentignores", s.handleCommentIgnores)
	// POST /api/workflows/task_snooze {repo?} → ensure the per-repo task-snooze
	// tracker; the UI then signals snooze/un-snooze to its Run ID via
	// .../signals/snooze.
	mux.HandleFunc("/api/workflows/task_snooze", s.handleTaskSnoozeStart)
	// GET /api/tasksnoozes → read-only task-snooze read-model (which tasks are
	// hidden, and until when). The UI filters expired entries at read time.
	mux.HandleFunc("/api/tasksnoozes", s.handleTaskSnoozes)
	// POST /api/workflows/auto_warn {repo?} → ensure the per-repo auto-warn
	// tracker; the UI then signals its on/off toggle to its Run ID via
	// .../signals/autowarn.
	mux.HandleFunc("/api/workflows/auto_warn", s.handleAutoWarnStart)
	// GET /api/autowarn → read-only auto-warn preference ({"enabled":bool}),
	// backing the toggle next to the theme button in prInfoCard.
	mux.HandleFunc("/api/autowarn", s.handleAutoWarn)
	// POST /api/workflows/task_inbox → ensure the per-repo task-inbox tracker
	// (its start synchronously aggregates the three task sources into the
	// taskinbox read-model). The generic .../signals/refresh handler (below)
	// re-triggers the aggregation on demand.
	mux.HandleFunc("/api/workflows/task_inbox", s.handleTaskInboxStart)
	// GET /api/tasks → read-only, derived task-inbox read-model (PR reviews,
	// unread comments on your own PRs, Jira tickets assigned to you).
	mux.HandleFunc("/api/tasks", s.handleTasks)
	// POST /api/workflows/claude_chat {pr, commentId} → ensure the claude_chat
	// Execution for an existing comment thread (idempotent, Run ID derived from
	// commentId); the UI then signals reviewer turns to its Run ID via
	// .../signals/message.
	mux.HandleFunc("/api/workflows/claude_chat", s.handleClaudeChatStart)
	// GET /api/chat?commentId=X → read-only chat transcript for one conversation
	// (see modules/chat; the conversation id IS the comment thread's id, so pr
	// isn't needed to scope the read).
	mux.HandleFunc("/api/chat", s.handleChat)
	// GET /api/chat/progress?commentId=X → the volatile snapshot of a RUNNING
	// turn (chat_progress.go): the resync read for the SSE stream below, not a
	// poll target.
	mux.HandleFunc("/api/chat/progress", s.handleChatProgress)
	// GET /api/chat/shadow-status?pr=N&commentId=X → read-only check of whether
	// a conversation's agentic-edit shadow worktree (chat_shadow.go) has pending
	// (uncommitted or locally-unpushed) work, so the UI can warn the reviewer
	// BEFORE "wis gesprek" (chatActionClear) discards it. A plain git-status/
	// rev-list read of a directory already on disk — no module write, no
	// workflow, no network — the same read-only-side-effect class as
	// blockstats.go/comment_import.go reading a worktree.
	mux.HandleFunc("/api/chat/shadow-status", s.handleChatShadowStatus)
	// GET /api/events?pr=N → the one multiplexed SSE stream per browser tab
	// (eventbus.go). Read-only and non-durable, like the heartbeat ping.
	mux.HandleFunc("/api/events", s.handleEvents)
	// POST /api/workflows/cleanup → manually trigger the daily data-retention
	// cleanup pass (purges all data of PRs merged more than 7 days ago). Runs
	// automatically once a day too — see StartCleanupScheduler.
	mux.HandleFunc("/api/workflows/cleanup", s.handleCleanup)
	// GET /api/problems → read-only: work that went wrong out of sight — failed
	// workflow runs (repo-wide) + the mirrored glue log lines. Feeds the
	// "Mislukte taken" block at the bottom of /pr-overview. See run_errors.go.
	mux.HandleFunc("/api/problems", s.handleProblems)
	// GET /api/prs/filter?preset=<key> → live gh-search for a fixed, allow-listed
	// preset query (never raw UI text — see handleFilter).
	mux.HandleFunc("/api/prs/filter", s.handleFilter)
	// GET /api/pr?pr=N → read-only PR metadata (title + URL) from the prmeta
	// read-model — for the `/` command menu's Jira/GitHub deep-links.
	mux.HandleFunc("/api/pr", s.handlePR)
	// GET /api/comments?pr=N → read-only comments + reactions for the UI
	mux.HandleFunc("/api/comments", s.handleComments)
	// GET /api/relations?pr=N → read-only block relations (edges) for the UI
	mux.HandleFunc("/api/relations", s.handleRelations)
	// GET /api/callresolve?pr=N → read-only call-resolution read-model (Go +
	// LLM-resolved definitions, and the unresolved calls behind the "Zoek" button)
	mux.HandleFunc("/api/callresolve", s.handleCallResolve)
	// GET /api/testcovers?pr=N → read-only test-coverage read-model (test →
	// covered method, both statically resolved and LLM-resolved, plus the
	// unannotated/unresolved rows behind the warning icon / "Zoek" action)
	mux.HandleFunc("/api/testcovers", s.handleTestCovers)
	// GET /api/explanations?pr=N → read-only AI unit-explanation read-model
	// (the footer's "AI-omschrijving" per if-containing line/group).
	mux.HandleFunc("/api/explanations", s.handleExplanations)
	// The inbox is owned by the pr_inbox workflow; these endpoints read its
	// read-model (never GitHub directly).
	mux.HandleFunc("/api/inbox", s.handleInbox)
	mux.HandleFunc("/api/inbox/status", s.handleInboxStatus)
}

// handleTaskCodeComment starts a code-comment Workflow Execution (POST) or lists
// executions (GET).
func (s *server) handleTaskCodeComment(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var in CodeCommentInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.File == "" || in.Body == "" {
			http.Error(w, "invalid comment", http.StatusBadRequest)
			return
		}
		if strings.Contains(in.File, "..") {
			http.Error(w, "invalid file", http.StatusBadRequest)
			return
		}
		runID, err := s.tasks.manager.StartCodeComment(r.Context(), in)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
	case http.MethodGet:
		runs, err := s.tasks.engine.Runs()
		if err != nil {
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		out := make([]tembed.RunRecord, 0, len(runs))
		for _, rec := range runs {
			if rec.Workflow == WorkflowTaskCodeComment {
				out = append(out, rec)
			}
		}
		writeJSON(w, http.StatusOK, out)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleWorkflowsList serves GET /api/workflows?pr=N — the read-only list of
// workflow runs scoped to that PR (the "Taken" column in RelatedPanel).
func (s *server) handleWorkflowsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	runs := s.tasks.manager.RunsForPR(pr)
	if runs == nil {
		runs = []WorkflowRunView{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "runs": runs})
}

// handleProblems serves GET /api/problems — the read-only "what went wrong out
// of sight" list behind the "Mislukte taken" block on /pr-overview: failed
// workflow runs (repo-wide, from the tembed store) plus the mirrored glue log
// lines (in-memory, lost on restart). Both slices are always non-nil so the
// client never has to guard for null.
func (s *server) handleProblems(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	failed := s.tasks.manager.FailedRuns(failedRunCap)
	if failed == nil {
		failed = []FailedRun{}
	}
	logs := loggedProblems()
	if logs == nil {
		logs = []LogProblem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "failedRuns": failed, "logErrors": logs})
}

// handleWorkflows routes /api/workflows/{runID} (GET status) and
// /api/workflows/{runID}/signals/{signalName} (POST signal).
func (s *server) handleWorkflows(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/workflows/")
	if rest == "" || rest == "task_code_comment" || rest == "pr_status" || rest == "resolve_call" || rest == "resolve_test_covers" || rest == "explain_code" || rest == "approve" || rest == "submit_review" || rest == "ready_for_review" || rest == "code_warning" || rest == "task_snooze" || rest == "ignore_comment" || rest == "task_inbox" || rest == "cleanup" || rest == "claude_chat" || rest == "auto_warn" {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	runID := parts[0]

	// POST /api/workflows/{runID}/heartbeat — the UI marks a thread as actively
	// viewed so the server keeps fast-polling GitHub. Writes no state (only
	// in-memory poll timing), so it sits outside the workflow write-boundary.
	if len(parts) == 2 && parts[1] == "heartbeat" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.tasks.manager.Heartbeat(runID)
		writeJSON(w, http.StatusOK, map[string]string{"status": "beat"})
		return
	}

	// POST /api/workflows/{runID}/signals/{signalName}
	if len(parts) == 3 && parts[1] == "signals" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// The inbox "refresh" signal carries no payload — it just asks the
		// pr_inbox workflow to re-fetch now (the UI's on-load re-check).
		if parts[2] == SignalRefresh {
			if err := s.tasks.manager.RefreshInbox(runID); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "refreshing"})
			return
		}
		// The build_relations "rebuild" signal carries no payload — it asks the
		// workflow to recompute the PR's relations now.
		if parts[2] == SignalRebuild {
			if err := s.tasks.engine.SignalWorkflow(runID, SignalRebuild, json.RawMessage("{}")); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "rebuilding"})
			return
		}
		// The "set" signal carries a block's full approved state (rows + call
		// segments) to the per-PR approve tracker — the UI write path for approval.
		if parts[2] == SignalSet {
			var body ApprovalSignal
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid approval", http.StatusBadRequest)
				return
			}
			if body.Viewed != nil {
				if body.File == "" {
					http.Error(w, "invalid viewed request", http.StatusBadRequest)
					return
				}
			} else if body.BlockID == "" {
				http.Error(w, "invalid approval", http.StatusBadRequest)
				return
			}
			if body.Rows == nil {
				body.Rows = []int{}
			}
			if body.Calls == nil {
				body.Calls = []string{}
			}
			if err := s.tasks.engine.SignalWorkflow(runID, SignalSet, body); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "set"})
			return
		}
		// The snooze signal carries one task id + an absolute expiry (or clear)
		// to the per-repo task-snooze tracker — the UI write path for
		// hiding/un-hiding a task.
		if parts[2] == SignalSnooze {
			var body SnoozeSignal
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TaskID == "" {
				http.Error(w, "invalid snooze", http.StatusBadRequest)
				return
			}
			if err := s.tasks.engine.SignalWorkflow(runID, SignalSnooze, body); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "snoozed"})
			return
		}
		// The ignore signal carries one comment id + the desired flag to the
		// per-PR ignore-comment tracker — the UI write path for hiding/showing
		// a PR-wide comment in the block index.
		if parts[2] == SignalIgnore {
			var body IgnoreCommentSignal
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.CommentID == "" {
				http.Error(w, "invalid ignore", http.StatusBadRequest)
				return
			}
			if err := s.tasks.engine.SignalWorkflow(runID, SignalIgnore, body); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "ignored"})
			return
		}
		// The autowarn signal carries the desired on/off flag for the automatic
		// code_warning trigger (from the UI toggle next to the theme button).
		if parts[2] == SignalAutoWarn {
			var body AutoWarnSignal
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid autowarn", http.StatusBadRequest)
				return
			}
			if err := s.tasks.engine.SignalWorkflow(runID, SignalAutoWarn, body); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "set"})
			return
		}
		// The delete signal carries no comment body — it just asks the workflow
		// to mark the comment "deleting" and remove it (see ReactionSignal).
		if parts[2] == SignalDelete {
			var body struct {
				Author string `json:"author"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body) // author is optional
			sig := ReactionSignal{
				ID: "ui-" + newUIReactionID(), Source: "ui",
				Author: body.Author, Action: "delete",
			}
			if err := s.tasks.manager.Signal(runID, sig); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "deleting"})
			return
		}
		// The message signal carries one reviewer turn to a claude_chat
		// conversation — the UI write path for the embedded Claude panel.
		// action ("" | "edit" | "commit") is validated here, BEFORE it ever
		// reaches the workflow/git-plumbing, per the validate-before-exec rule —
		// see ChatMessageSignal's own doc comment for what each value means.
		if parts[2] == SignalMessage {
			var body struct {
				Author  string `json:"author"`
				Body    string `json:"body"`
				Action  string `json:"action"`
				Context string `json:"context"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid message", http.StatusBadRequest)
				return
			}
			switch body.Action {
			case "", chatActionEdit:
				// A plain question or an edit instruction both need real text —
				// only "commit"/"clear" (below) need none.
				if strings.TrimSpace(body.Body) == "" {
					http.Error(w, "invalid message", http.StatusBadRequest)
					return
				}
			case chatActionCommit, chatActionClear:
				// No text required — "commit" pushes whatever Claude already
				// changed, "clear" wipes the conversation; neither asks it anything.
			default:
				http.Error(w, "invalid action", http.StatusBadRequest)
				return
			}
			sig := ChatMessageSignal{
				ID: "msg-" + newUIReactionID(), Author: body.Author, Body: body.Body, Action: body.Action,
				Context: body.Context,
			}
			if err := s.tasks.engine.SignalWorkflow(runID, SignalMessage, sig); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "signalled"})
			return
		}
		if parts[2] != SignalReply {
			http.Error(w, "unknown signal", http.StatusBadRequest)
			return
		}
		// action ("" | "edit") is validated here, before it ever reaches the
		// workflow — mirrors the message-signal switch above. "edit" changes the
		// wording of an EXISTING message (targetId names it: the run's own id for
		// the root comment, or an existing reply's id) instead of adding a new one.
		var body struct {
			Author   string `json:"author"`
			Body     string `json:"body"`
			Done     bool   `json:"done"`
			Action   string `json:"action"`
			TargetID string `json:"targetId"`
			// publish/publishHistory promote a still-local thread to GitHub as
			// part of this reply — see ReactionSignal.Publish.
			Publish        string `json:"publish"`
			PublishHistory bool   `json:"publishHistory"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid reaction", http.StatusBadRequest)
			return
		}
		switch body.Action {
		case "":
			if body.Body == "" {
				http.Error(w, "invalid reaction", http.StatusBadRequest)
				return
			}
		case "edit":
			if body.Body == "" || body.TargetID == "" {
				http.Error(w, "invalid edit", http.StatusBadRequest)
				return
			}
		case "publish":
			// Carries no message: it publishes the thread as it stands (see
			// ReactionSignal's "publish" Action), so an empty body is correct.
		default:
			http.Error(w, "invalid action", http.StatusBadRequest)
			return
		}
		// publish is only meaningful while ADDING a reply, and only in its two
		// known shapes — validated here, before it ever reaches the workflow,
		// like the action switch above.
		switch body.Publish {
		case "":
		case "reply", "thread":
			if body.Action != "" {
				http.Error(w, "invalid publish", http.StatusBadRequest)
				return
			}
		default:
			http.Error(w, "invalid publish", http.StatusBadRequest)
			return
		}
		sig := ReactionSignal{
			ID: "ui-" + newUIReactionID(), Source: "ui",
			Author: body.Author, Body: body.Body, Done: body.Done, Action: body.Action,
			Publish: body.Publish, PublishHistory: body.PublishHistory,
		}
		if body.Action == "edit" {
			sig.ID = body.TargetID
		}
		if err := s.tasks.manager.Signal(runID, sig); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "signalled"})
		return
	}

	// GET /api/workflows/{runID}
	if len(parts) == 1 && r.Method == http.MethodGet {
		status, err := s.tasks.engine.Status(runID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"runId": runID, "status": status})
		return
	}
	http.NotFound(w, r)
}

// handleComments serves GET /api/comments?pr=N — the read-only comments +
// reactions read-model the UI renders.
func (s *server) handleComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// ?path=<prefix> does a hierarchical prefix search over the comment paths
	// (e.g. /pr-123 for a whole PR, /pr-123/app/Foo.php for one file); ?pr=N is
	// the plain per-PR list. Both are read-only.
	var (
		list []comments.Comment
		err  error
	)
	if prefix := r.URL.Query().Get("path"); prefix != "" {
		list, err = s.tasks.comments.Search(r.Context(), prefix)
	} else {
		pr := 0
		if v := r.URL.Query().Get("pr"); v != "" {
			pr, _ = strconv.Atoi(v)
		}
		list, err = s.tasks.comments.List(r.Context(), pr)
	}
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []comments.Comment{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleRelations serves GET /api/relations?pr=N — the read-only block-relations
// read-model (parent→child edges) the UI uses to nest children under a block.
func (s *server) handleRelations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.relations.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []relations.Relation{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleResolveCall starts an LLM call-resolution Workflow Execution (POST). It
// is the sanctioned UI write path for the "Zoek" action — the workflow runs
// Haiku, escalates to Sonnet if needed, and writes the callresolve read-model.
func (s *server) handleResolveCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ResolveCallInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 || in.CallerID == "" || len(in.Calls) == 0 {
		http.Error(w, "invalid resolve request", http.StatusBadRequest)
		return
	}
	if strings.Contains(in.CallerFile, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartResolveCall(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleCallResolve serves GET /api/callresolve?pr=N — the read-only
// call-resolution read-model (resolved/found definitions + unresolved calls).
func (s *server) handleCallResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.callresolve.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []callresolve.Entry{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleExplainCode starts an explain_code Workflow Execution (POST) — the
// sanctioned UI write path for the footer's AI unit description. The workflow
// asks Haiku (context-only) to describe the unit's if-statement and writes the
// explanations read-model. Idempotent per unit+code-hash (StartWorkflowID).
func (s *server) handleExplainCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ExplainCodeInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil ||
		in.PR <= 0 || in.BlockID == "" || in.UnitKey == "" || in.CodeHash == "" || in.Code == "" {
		http.Error(w, "invalid explain request", http.StatusBadRequest)
		return
	}
	if strings.Contains(in.File, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartExplainCode(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleExplanations serves GET /api/explanations?pr=N — the read-only AI
// unit-explanation read-model the footer renders.
func (s *server) handleExplanations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.explain.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []explanations.Entry{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleResolveTestCovers starts an LLM test-coverage resolution Workflow
// Execution (POST). It is the sanctioned UI write path for a class-level-only
// coverage annotation (#[CoversClass]/bare "@covers Class") the Go analyzer
// left "unresolved" — the workflow runs Haiku, escalates to Sonnet if needed,
// and writes the testcovers read-model. Never used for an "unannotated" test.
func (s *server) handleResolveTestCovers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ResolveTestCoversInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 || in.TestID == "" || len(in.Classes) == 0 {
		http.Error(w, "invalid resolve request", http.StatusBadRequest)
		return
	}
	if strings.Contains(in.TestFile, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartResolveTestCovers(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleTestCovers serves GET /api/testcovers?pr=N — the read-only
// test-coverage read-model (resolved/found covered methods, plus the
// unannotated/unresolved rows).
func (s *server) handleTestCovers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.testcovers.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []testcovers.Entry{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handlePRStatusStart starts (or reuses) the per-PR pr_status tracker. Starting
// an Execution is the sanctioned UI write path; its start synchronously fetches
// the PR's metadata into the prmeta read-model. The UI calls this on page load.
func (s *server) handlePRStatusStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.EnsurePRStatus(in.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleApproveStart starts (or reuses) the per-PR approve tracker and returns
// its Run ID. Starting an Execution is the sanctioned UI write path; the UI then
// signals approvals to this Run ID via .../signals/set.
func (s *server) handleApproveStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.EnsureApprovals(in.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleApprovals serves GET /api/approvals?pr=N — the read-only approval
// read-model (per block: approved changed rows + call segments) the UI restores
// on load.
func (s *server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	list, err := s.tasks.approvals.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []approvals.Approval{}
	}
	writeJSON(w, http.StatusOK, list)
}

// handleIgnoreCommentStart starts (or reuses) the per-PR ignore-comment tracker
// and returns its Run ID. Starting an Execution is the sanctioned UI write path;
// the UI then signals ignore/un-ignore to this Run ID via .../signals/ignore.
// Mirrors handleApproveStart.
func (s *server) handleIgnoreCommentStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.EnsureIgnoreComment(in.PR)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleCommentIgnores serves GET /api/commentignores?pr=N — the read-only
// ignore-comment read-model (the ids of the PR-wide comments hidden from the
// block index) the UI restores on load.
func (s *server) handleCommentIgnores(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	if pr <= 0 {
		http.Error(w, "missing pr", http.StatusBadRequest)
		return
	}
	list, err := s.tasks.commentignore.List(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": list})
}

// handleTaskSnoozeStart starts (or reuses) the per-repo task-snooze tracker and
// returns its Run ID. Starting an Execution is the sanctioned UI write path;
// the UI then signals snooze/un-snooze to this Run ID via .../signals/snooze.
func (s *server) handleTaskSnoozeStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	runID, err := s.tasks.manager.EnsureTaskSnooze()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleTaskSnoozes serves GET /api/tasksnoozes — the read-only task-snooze
// read-model (which tasks are hidden, and until when). It does not filter
// expired entries: the UI compares Until against Date.now() at read time.
func (s *server) handleTaskSnoozes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	list, err := s.tasks.tasksnooze.List(r.Context())
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []tasksnooze.Snooze{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "snoozes": list})
}

// handleAutoWarnStart starts (or reuses) the per-repo auto-warn tracker and
// returns its Run ID. Starting an Execution is the sanctioned UI write path;
// the UI then signals its on/off toggle to this Run ID via
// .../signals/autowarn.
func (s *server) handleAutoWarnStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	runID, err := s.tasks.manager.EnsureAutoWarn()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleAutoWarn serves GET /api/autowarn — the read-only on/off preference
// for the automatic code_warning trigger. Defaults to enabled (see
// modules/autowarn.Enabled).
func (s *server) handleAutoWarn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	enabled, err := s.tasks.manager.AutoWarnEnabled(r.Context())
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": enabled})
}

// handleTaskInboxStart starts (or reuses) the per-repo task-inbox tracker and
// returns its Run ID. EnsureTaskInbox is normally already called once at
// server startup (newTasks); this only calls it again if that hasn't
// happened yet (e.g. a one-shot CLI process with resumeRuntime=false) —
// EnsureTaskInbox spawns a poller goroutine, so it must not be called on
// every request once a Run ID already exists. The UI can then re-trigger the
// aggregation via the generic .../signals/refresh handler above.
func (s *server) handleTaskInboxStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.tasks.manager.TaskInboxRunID() == "" {
		s.tasks.manager.EnsureTaskInbox(r.Context())
	}
	runID := s.tasks.manager.TaskInboxRunID()
	if runID == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "task inbox not ready"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleTasks serves GET /api/tasks — the read-only, derived task-inbox
// read-model (PR reviews, unread comments on your own PRs, Jira tickets
// assigned to you), aggregated + scored by the task_inbox workflow.
func (s *server) handleTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	list, err := s.tasks.taskinbox.List(r.Context())
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []taskinbox.Task{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tasks": list})
}

// handleClaudeChatStart serves POST /api/workflows/claude_chat {pr, commentId}
// → ensures the claude_chat Execution for that comment thread (idempotent via
// StartClaudeChat's deterministic Run ID) and returns its Run ID, which the UI
// then signals reviewer turns to via .../signals/message. commentId must name
// an existing comment of pr (per product decision, a chat always hangs off a
// comment thread — the UI creates an empty private one first if none exists
// at the selected spot yet).
func (s *server) handleClaudeChatStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		PR        int    `json:"pr"`
		CommentID string `json:"commentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 || in.CommentID == "" {
		http.Error(w, "invalid chat request", http.StatusBadRequest)
		return
	}
	list, err := s.tasks.comments.List(r.Context(), in.PR)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	found := false
	for _, c := range list {
		if c.ID == in.CommentID {
			found = true
			break
		}
	}
	if !found {
		http.Error(w, "unknown comment", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartClaudeChat(ClaudeChatInput{PR: in.PR, CommentID: in.CommentID})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleChat serves two read-only reads, both GET:
//
//   - ?commentId=X — the chat transcript for the conversation hanging off that
//     comment thread.
//   - ?pr=N — only the ids of the PR's conversations that actually have turns
//     ({"conversations": [...]}), no bodies. One request per PR, so the frontend
//     can answer "does this unit already have a Claude conversation" (and thus
//     "should the chat column exist") without a fetch per comment.
func (s *server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	if pr > 0 {
		ids, err := s.tasks.chat.ConversationsWithMessages(r.Context(), pr)
		if err != nil {
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		if ids == nil {
			ids = []string{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "conversations": ids})
		return
	}
	commentID := r.URL.Query().Get("commentId")
	if commentID == "" {
		http.Error(w, "commentId or pr required", http.StatusBadRequest)
		return
	}
	list, err := s.tasks.chat.List(r.Context(), commentID)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []chat.Message{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "messages": list})
}

// handleChatProgress serves GET /api/chat/progress?commentId=X — the volatile
// "what is Claude doing right now" snapshot of a running turn (chat_progress.go).
// It is the RESYNC read for the SSE stream, not a poll target: a tab that opens
// or reconnects mid-turn has missed every chat.progress event so far and catches
// up with this one call. No running turn → {ok:true, running:false}, so the
// caller needs no 404 special case.
func (s *server) handleChatProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	commentID := r.URL.Query().Get("commentId")
	if commentID == "" {
		http.Error(w, "commentId required", http.StatusBadRequest)
		return
	}
	p, ok := chatProgressFor(commentID)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "running": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "running": true, "progress": p})
}

// handleChatShadowStatus serves GET /api/chat/shadow-status?pr=N&commentId=X —
// see the route registration above for why this needs no workflow. No shadow
// worktree at all → {ok:true, exists:false}; otherwise {exists:true, dirty,
// ahead} from chatShadowLocalPendingState (chat_shadow.go), a purely local
// git-plumbing read. A read that itself fails is reported as pending (dirty:
// true) rather than silently "nothing to warn about" — conservative, same
// "can't tell → don't discard" reasoning ensureChatShadowWorktreeAt already
// uses.
func (s *server) handleChatShadowStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr, _ := strconv.Atoi(r.URL.Query().Get("pr"))
	commentID := r.URL.Query().Get("commentId")
	if pr <= 0 || commentID == "" {
		http.Error(w, "pr and commentId required", http.StatusBadRequest)
		return
	}
	dir := chatShadowDir(s.dataDir, pr, commentID)
	if _, err := os.Stat(dir); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "exists": false})
		return
	}
	dirty, ahead, err := chatShadowLocalPendingState(r.Context(), dir)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "exists": true, "dirty": true, "ahead": 0})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "exists": true, "dirty": dirty, "ahead": ahead})
}

// sseKeepAlive is how often an idle stream writes a comment frame. Without it a
// connection that says nothing for minutes (the normal state) can be reaped by
// the browser or an intermediary; a bare ":" line is ignored by EventSource.
const sseKeepAlive = 20 * time.Second

// handleEvents serves GET /api/events?pr=N — ONE server-sent-events stream per
// browser tab, over which every subject is multiplexed (see eventbus.go and
// .claude/docs/server-events.md). Read-only and stateless: it starts nothing,
// writes nothing durable, and only forwards volatile notifications, so it falls
// under the same operational carve-out as the heartbeat ping.
//
// The optional ?pr= narrows the stream to one PR (plus PR-less events); the
// finer "which conversation/block" filtering happens client-side on the event's
// Key. EventSource cannot renegotiate after connecting, so a scope change is
// simply a reconnect — which keeps this handler free of any subscription
// protocol of its own.
func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	pr, _ := strconv.Atoi(r.URL.Query().Get("pr"))
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Belt and braces for any proxy that would otherwise buffer the stream.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// A generous reconnect delay: the browser reconnects on its own after any
	// drop, and this is a convenience channel — never a fast retry storm.
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()

	id, sub := events.subscribe(pr)
	defer events.unsubscribe(id)

	ticker := time.NewTicker(sseKeepAlive)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-sub.ch:
			if !open {
				return
			}
			if sub.dropped.Swap(false) {
				// This connection fell behind and lost at least one event; tell it
				// to refetch instead of pretending the stream was complete.
				writeSSE(w, busEvent{Type: eventResync})
			}
			writeSSE(w, ev)
			flusher.Flush()
		case <-ticker.C:
			if sub.dropped.Swap(false) {
				writeSSE(w, busEvent{Type: eventResync})
			}
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// writeSSE emits one frame. Deliberately no `event:` line — the type lives in
// the JSON payload so a single EventSource.onmessage can fan every subject out
// client-side (see eventbus.go's own comment on that choice). The payload is
// one JSON object, which can never contain a raw newline, so a single
// "data:" line is always enough.
func writeSSE(w io.Writer, ev busEvent) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	if ev.Seq > 0 {
		fmt.Fprintf(w, "id: %d\n", ev.Seq)
	}
	fmt.Fprintf(w, "data: %s\n\n", b)
}

// filterPresets maps an allow-listed preset key to its fixed GitHub search
// expression (the qualifier set AFTER "repo:<slug>", including its own sort:).
// Only these fixed expressions ever reach gh — raw UI text is never passed to
// the subprocess (per the exec-input-validation convention). An unknown key is
// a 400. The "ouder-dan-3-dagen" preset's date bound is filled in dynamically by
// handleFilter (a read handler — a real clock is fine here, the determinism rule
// only governs workflow bodies).
var filterPresets = map[string]string{
	"updated-oud": "is:pr is:open draft:false sort:created-asc",
	"alle-open":   "is:pr state:open draft:false sort:updated-desc",
	"alle-draft":  "is:pr state:open draft:true sort:updated-desc",
	// %s is replaced with a YYYY-MM-DD bound (today − 3 days).
	"ouder-3-dagen": "is:pr is:open draft:false created:<%s sort:created-asc",
}

// handleFilter serves GET /api/prs/filter?preset=<key> — a live gh-search for a
// fixed, allow-listed preset expression (full rows, like /api/prs/search). The
// expression is chosen from filterPresets by key, never built from raw UI input.
func (s *server) handleFilter(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := r.URL.Query().Get("preset")
	expr, ok := filterPresets[key]
	if !ok {
		http.Error(w, "unknown preset", http.StatusBadRequest)
		return
	}
	if key == "ouder-3-dagen" {
		bound := time.Now().AddDate(0, 0, -3).Format("2006-01-02")
		expr = fmt.Sprintf(expr, bound)
	}

	if ghDisabled() {
		rows := []inboxRow{}
		if f, ok := loadFixture(); ok {
			wantDraft := strings.Contains(expr, "draft:true")
			for _, row := range fixtureRows(f) {
				// Offline: honour only the draft: qualifier of the preset (the
				// fixture carries no created-date to filter on); everything else
				// passes through so tests see the full fixture set.
				if wantDraft != row.IsDraft {
					continue
				}
				rows = append(rows, row)
			}
		}
		overlayGraph(s.db, rows)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prs": rows})
		return
	}

	// searchPRsExpr prepends repo:<slug> and trusts the preset's own sort:.
	rows, err := searchPRsExpr(r.Context(), expr, false)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false})
		return
	}
	overlayGraph(s.db, rows)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prs": rows})
}

// handlePR serves GET /api/pr?pr=N — the read-only PR metadata from the prmeta
// read-model, filled in three progressive stages by the pr_status tracker
// (basics → Claude summary → review/CI statuses). {ok:false} while the tracker
// hasn't fetched anything yet; once ok, fields whose stage hasn't landed yet are
// simply zero values (empty summary/reviewDecision, checksTotal 0, …) so the UI
// can render progressively instead of waiting for every stage.
func (s *server) handlePR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr := 0
	if v := r.URL.Query().Get("pr"); v != "" {
		pr, _ = strconv.Atoi(v)
	}
	meta, ok, err := s.tasks.prmeta.Get(r.Context(), pr)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "pr": pr})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "pr": meta.PR, "title": meta.Title, "url": meta.URL, "updatedAt": meta.UpdatedAt,
		"body": meta.Body, "author": meta.Author, "additions": meta.Additions, "deletions": meta.Deletions,
		"changedFiles": meta.ChangedFiles, "headRef": meta.HeadRef,
		"summary": meta.Summary,
		"jiraKey": meta.JiraKey, "jiraTitle": meta.JiraTitle, "jiraDesc": meta.JiraDesc, "jiraUrl": meta.JiraURL,
		"reviewDecision": meta.ReviewDecision, "checksTotal": meta.ChecksTotal, "checksPassed": meta.ChecksPassed,
		"reviewers": meta.Reviewers,
	})
}

// validateSubmitReview checks a submit_review request before it ever reaches
// the workflow/gh: pr must be a positive int, event must be one of GitHub's
// two review-submission actions this app exposes, and — because GitHub
// itself rejects a bodyless REQUEST_CHANGES review — a request-changes
// review must carry a non-empty body (an APPROVE may be bodyless). Trims and
// upper-cases in.Event, and trims in.Body, in place, so a caller that passes
// validation always has a clean value to send on.
func validateSubmitReview(in *SubmitReviewInput) error {
	if in.PR <= 0 {
		return fmt.Errorf("invalid pr")
	}
	in.Event = strings.ToUpper(strings.TrimSpace(in.Event))
	if in.Event != "APPROVE" && in.Event != "REQUEST_CHANGES" {
		return fmt.Errorf("invalid event %q", in.Event)
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Event == "REQUEST_CHANGES" && in.Body == "" {
		return fmt.Errorf("request-changes review requires a non-empty body")
	}
	return nil
}

// handleSubmitReview starts a submit_review Workflow Execution (POST) — the
// sanctioned write path for submitting a real GitHub PR-level review (approve
// or request changes). validateSubmitReview rejects an invalid request (bad
// pr/event, or a bodyless request-changes) before the workflow ever starts.
func (s *server) handleSubmitReview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in SubmitReviewInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if err := validateSubmitReview(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartSubmitReview(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleCleanup starts a cleanup Workflow Execution (POST) — the sanctioned
// write path for manually triggering the daily data-retention purge (it also
// runs automatically once a day, see StartCleanupScheduler). No request body:
// the cutoff (now − cleanupMergedAge) is always computed server-side, so a
// caller can't widen the safety window via the API.
func (s *server) handleCleanup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	res, err := s.tasks.manager.StartCleanup(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// reReviewerLogin restricts a reviewer login to GitHub's username charset
// before the request reaches the workflow (defence in depth alongside the
// github module's own check).
var reReviewerLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)

// validateReadyForReview checks a ready_for_review request before the workflow
// starts: pr must be positive and every reviewer login must be a valid GitHub
// username. Trims + dedups Reviewers in place.
func validateReadyForReview(in *ReadyForReviewInput) error {
	if in.PR <= 0 {
		return fmt.Errorf("invalid pr")
	}
	seen := map[string]bool{}
	out := in.Reviewers[:0]
	for _, login := range in.Reviewers {
		login = strings.TrimSpace(login)
		if login == "" || seen[login] {
			continue
		}
		if !reReviewerLogin.MatchString(login) {
			return fmt.Errorf("invalid reviewer login %q", login)
		}
		seen[login] = true
		out = append(out, login)
	}
	in.Reviewers = out
	return nil
}

// handleReadyForReview starts a ready_for_review Workflow Execution (POST) —
// the sanctioned write path for flipping a draft PR to ready + requesting
// reviewers. Invalid requests are rejected before the workflow starts.
func (s *server) handleReadyForReview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in ReadyForReviewInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if err := validateReadyForReview(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartReadyForReview(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}

// handleReviewers returns the repo's candidate reviewers (collaborators),
// sorted most-used-first by the local reviewer-usage counts (ties and
// never-used collaborators fall back to alphabetical). Read-only.
func (s *server) handleReviewers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cands, err := s.tasks.manager.Reviewers(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reviewers": cands})
}

// handleMe returns the authenticated GitHub user — the local reviewer's login
// and profile picture — so the UI can render own (ui-sourced) comments and
// replies with a real name/avatar instead of the "reviewer" placeholder those
// are stored with. Read-only, cached for the process lifetime (see
// TaskManager.CurrentUser). A failing lookup (no gh, offline, SLASH_GITHUB=off)
// answers {ok:false} with a 200: the frontend then simply keeps whatever the
// comment itself carries, so this is never a hard error.
func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	me, err := s.tasks.manager.CurrentUser(r.Context())
	if err != nil || me.Login == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "login": me.Login, "avatarUrl": me.AvatarURL})
}

// handleNames resolves a comma-separated list of GitHub logins to their human
// name + avatar (see usernames.go: the local names.json override first, then the
// GitHub profile name). Read-only and cached for the process lifetime, so a page
// that asks for the same logins again costs nothing.
//
// Never a hard error: an unresolvable login just comes back with an empty name,
// and the frontend then shows the bare login — the same "always answer 200"
// contract as handleMe.
func (s *server) handleNames(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	logins := []string{}
	for _, part := range strings.Split(r.URL.Query().Get("logins"), ",") {
		if p := strings.TrimSpace(part); p != "" {
			logins = append(logins, p)
		}
		if len(logins) >= nameLookupCap {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"names": s.tasks.manager.DisplayNames(r.Context(), logins),
	})
}

// handleCodeWarning starts a code_warning Workflow Execution (POST) — an
// agentic Opus review of a PR's changed files for risks. The only current
// caller is the "/" menu's "Diepgravend onderzoek" (see StartCodeWarning);
// Files is always omitted from the request today (a full baseline run) — the
// field exists for a future incremental fast-follow.
func (s *server) handleCodeWarning(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in CodeWarningInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.PR <= 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartCodeWarning(in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}
