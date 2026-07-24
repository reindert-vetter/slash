package main

import (
	"context"
	"database/sql"
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
	"slash/modules/approvals"
	"slash/modules/callresolve"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/explanations"
	"slash/modules/github"
	"slash/modules/ignore"
	"slash/modules/inbox"
	"slash/modules/jira"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/reviewerusage"
	"slash/modules/testcovers"
)

// This file wires the first task as a durable tembed Workflow. Terminology
// follows Temporal: a Workflow Type (task_code_comment) started as a Workflow
// Execution (identified by a Run ID), which drives Activities and reacts to
// Signals. The Workflow is the only writer of state; it drives two modules —
// the comments module (its own read-model store) and the github module — as
// Activities. Reactions hook onto a comment as "reply" Signals, delivered from
// both the UI and a GitHub poller.

const (
	// WorkflowTaskCodeComment is the Workflow Type; also the endpoint segment
	// POST /api/workflows/task_code_comment.
	WorkflowTaskCodeComment = "task_code_comment"
	// WorkflowPRStatus is the Workflow Type of the per-PR lifecycle tracker: one
	// Execution per PR, completing once the PR is merged or closed. It is the
	// durable record the comment pollers read to stop.
	WorkflowPRStatus = "pr_status"
	// WorkflowPRInbox is the Workflow Type that owns the PR inbox: one Execution
	// per repo. Each "refresh" Signal drives an Activity that fetches the inbox
	// from GitHub and writes it into the inbox read-model. It is the only path
	// that reads GitHub for the overview — the HTTP handlers read the read-model.
	WorkflowPRInbox = "pr_inbox"
	// WorkflowBuildRelations is the Workflow Type that derives block relations
	// (the call-graph edges): one Execution per PR. It runs a build once on start
	// and again on each "rebuild" Signal (re-ingest). Designed to be extended with
	// more relation detectors later.
	WorkflowBuildRelations = "build_relations"
	// WorkflowApprove is the Workflow Type that persists reviewer approval: one
	// Execution per PR. Each "set" Signal carries a block's full approved state
	// (rows + call segments), which one Activity full-swaps into the approvals
	// read-model — so a browser refresh restores exactly what was ticked off.
	WorkflowApprove = "approve"
	// WorkflowIngest is the Workflow Type that runs the ingest pipeline for a PR:
	// fetch meta/worktrees, diff+parse+classify, and full-swap the resulting
	// blocks into the DB. One Execution per ingest request; it completes once
	// done (no signals). This is the only path that writes the blocks table /
	// touches the git worktrees — the sole write boundary for ingest.
	WorkflowIngest = "ingest"
	// WorkflowResolveCall is the Workflow Type that resolves a changed block's
	// method calls to their definition with an LLM when the Go resolver could not:
	// it runs Haiku first and, if that is not confident, escalates automatically to
	// Sonnet (no signal). One Execution per resolve request; it completes when done.
	WorkflowResolveCall = "resolve_call"
	// WorkflowResolveTestCovers is the Workflow Type that resolves which method
	// a test covers with an LLM, for the class-level-only coverage annotations
	// the Go analyzer could not turn into a specific method
	// (#[CoversClass]/bare "@covers Class"): it runs Haiku first and, if that is
	// not confident, escalates automatically to Sonnet (no signal). A test with
	// no coverage annotation at all never reaches this workflow — that case is
	// "unannotated" and only ever shown as a warning. One Execution per resolve
	// request; it completes when done.
	WorkflowResolveTestCovers = "resolve_test_covers"
	// WorkflowExplainCode is the Workflow Type that generates a short Dutch AI
	// description of the if-statement inside one selected navigation unit (a
	// line/group of a block's diff), shown in the footer. One Execution per
	// unit+code-hash, started idempotently via a deterministic Run ID (see
	// explainRunID) so a repeated selection never triggers a second LLM call; it
	// completes when done (no signals). Haiku, context-only — no escalation.
	WorkflowExplainCode = "explain_code"
	// WorkflowSubmitReview is the Workflow Type that submits a real GitHub
	// PR-level review (approve or request changes): one Execution per submit
	// request. It runs its one Activity (the gh api call) synchronously and
	// completes — no signal, mirrors WorkflowIngest.
	WorkflowSubmitReview = "submit_review"
	// WorkflowReadyForReview is the Workflow Type that flips a draft PR to
	// "ready for review" and (optionally) requests reviewers: one Execution
	// per request. It runs its Activities (mark ready → request reviewers →
	// bump the local reviewer-usage counts) synchronously and completes — no
	// signal, mirrors WorkflowSubmitReview.
	WorkflowReadyForReview = "ready_for_review"
	// WorkflowCodeWarning is the Workflow Type that agentically reviews a PR's
	// changed files for risks (correctness/security/style, and consistency
	// with the connected code the changes touch — callers, callees, tests,
	// listeners) using Sonnet with Read/Grep/Glob in the head worktree. One
	// Execution per manual "Controleer de hele PR op risico's" run (see the
	// "/" PR_COMMANDS menu); it re-checks the whole PR each time and
	// supersedes (deletes, via the existing delete Signal) the AI warnings of
	// every file in scope before creating fresh ones. No signal — it runs its
	// Activities sequentially and completes. See
	// .claude/rules/tembed-workflows.md ("AI-risicocontrole").
	WorkflowCodeWarning = "code_warning"
	// WorkflowIgnore is the Workflow Type that persists which PRs the reviewer
	// chose to hide from the inbox: one Execution per repo. Each "ignore" Signal
	// carries one PR + an absolute expiry (computed by the UI, so the body needs
	// no clock), which one Activity writes into the ignore read-model. It never
	// completes — a long-lived per-repo tracker.
	WorkflowIgnore = "ignore"
	// SignalReply is the Signal Name a reaction is delivered under.
	SignalReply = "reply"
	// SignalPRState is the Signal Name the poller delivers an observed PR state
	// under to the pr_status tracker.
	SignalPRState = "state"
	// SignalRefresh asks the pr_inbox workflow to re-fetch the inbox now (sent by
	// the UI on page load and by the poller on its cadence).
	SignalRefresh = "refresh"
	// SignalRebuild asks the build_relations workflow to recompute a PR's
	// relations now (sent after a re-ingest).
	SignalRebuild = "rebuild"
	// SignalSet delivers a block's full approved state to the approve workflow
	// (from the UI, on every approve/un-approve toggle).
	SignalSet = "set"
	// SignalIgnore delivers one PR's ignore state to the ignore workflow (from
	// the UI, on "Negeer PR" / un-ignore). It carries an absolute expiry
	// timestamp the UI computed, so the workflow body needs no clock.
	SignalIgnore = "ignore"
	// SignalDelete is the URL-level signal name the UI posts to delete a
	// comment. It is delivered to the workflow as a ReactionSignal (Action:
	// "delete") under SignalReply — see ReactionSignal's doc comment.
	SignalDelete = "delete"

	// pollInterval is the fast cadence the GitHub poller uses while the reviewer
	// is actively viewing the thread (a heartbeat arrived within heartbeatWindow).
	pollInterval = time.Minute
	// idlePollInterval is the slow cadence once no heartbeat has arrived within
	// heartbeatWindow. Only on this slow cadence does the poller also check
	// whether the PR is merged/closed (and then stop).
	idlePollInterval = 10 * time.Minute
	// heartbeatWindow is how recent the last heartbeat must be to keep the fast
	// cadence; older than this and the poller backs off to idlePollInterval.
	heartbeatWindow = 10 * time.Minute
)

// CodeCommentInput starts a code-comment Workflow Execution.
type CodeCommentInput struct {
	PR     int    `json:"pr"`
	File   string `json:"file"`
	Line   int    `json:"line"`
	Author string `json:"author"`
	Body   string `json:"body"`
	// Code is the source snippet the comment attaches to, with Gran/Label
	// describing it — carried so the thread shows the same code the composer did.
	Code  string `json:"code"`
	Gran  string `json:"gran"`
	Label string `json:"label"`
	// RowStart/RowEnd/Seg pin the comment to its exact navigation unit within the
	// block (aligned-diff row range + call segment) so the comment index can be
	// filtered to the units under the current selection. RowStart < 0 = unknown.
	RowStart int    `json:"rowStart"`
	RowEnd   int    `json:"rowEnd"`
	Seg      string `json:"seg"`
	// StartLine/EndLine are the source line numbers (on Side) the GitHub review
	// comment anchors to: a single line when equal (or when StartLine is 0), a
	// multi-line range otherwise (GitHub requires StartLine < EndLine). Falls
	// back to Line when both are 0, for backward compatibility with callers that
	// only set Line. Side is "RIGHT" (new/context line) or "LEFT" (a removed
	// line); empty defaults to "RIGHT".
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Side      string `json:"side"`
	// Segment is the call-segment text (gran "call") shown as a code-span at the
	// top of the GitHub-posted body, for context on which part of the line the
	// comment targets. It never touches the stored comment's Body.
	Segment string `json:"segment"`
	// Local marks a private note: it is stored as a comment but never posted to
	// GitHub. The workflow then skips postGithubComment, so posted.RootID stays 0
	// and every downstream github call (poller, reply mirror, delete) no-ops via
	// its existing RootID == 0 guard.
	Local bool `json:"local"`
	// ImportedRootID is set when this comment is imported from an existing GitHub
	// comment (a thread-root that already lives on GitHub, made outside this app).
	// The workflow then SKIPS postGithubComment (it's already there) but still
	// records posted.RootID = ImportedRootID, so the reply poller runs and UI
	// replies mirror to the real thread — unlike Local, which disables all that.
	ImportedRootID int64 `json:"importedRootId"`
	// Source is "ui" (placed in this app, default), "github" (imported), or
	// "ai" (an automated finding from the code_warning workflow — always
	// paired with Local: true, since an AI finding never posts to GitHub).
	// Stored on the comment; the frontend badges github- and ai-sourced
	// comments differently (a warning-triangle icon for "ai").
	Source string `json:"source"`
	// Kind classifies the comment's anchor: "" (a normal line/block comment) or
	// "issue"/"review_summary"/"review"/"ai_warning" for a PR-wide comment
	// with no file:line anchor (shown in the PR-info column, not the
	// block-scoped index). "review" is a review comment that couldn't be
	// pinned to any block; "ai_warning" is a code_warning finding whose
	// file+line couldn't be pinned to any block either (see anchoredWarning
	// in code_warning.go) — an anchorable finding instead gets Kind "" like
	// any other line comment.
	Kind string `json:"kind"`
	// CreatedAt carries an imported comment's original GitHub timestamp so the
	// thread shows when it was really written (saveComment defaults it to now when
	// empty, for app-placed comments).
	CreatedAt string `json:"createdAt"`
}

// ReactionSignal is the payload of a "reply" Signal. It carries either a
// reaction hooking onto the comment (Action "" / "reply", from the UI or from
// GitHub) or a request to delete the comment (Action "delete") — both ride the
// same Signal because a workflow can only WaitSignal on one name at a time
// (see taskCodeCommentWorkflow's reactions loop), so a delete request has to
// be delivered as a distinguishable reply rather than a signal of its own.
type ReactionSignal struct {
	ID     string `json:"id"`
	Source string `json:"source"` // ui | github
	Author string `json:"author"`
	Body   string `json:"body"`
	Done   bool   `json:"done"`   // resolves the thread
	Action string `json:"action"` // "" (reply, default) | "delete"
}

// postResult carries the GitHub root comment ID (0 when GitHub is unavailable).
type postResult struct {
	RootID int64 `json:"rootId"`
}

// PRStatusInput starts a pr_status Workflow Execution — one tracker per PR.
type PRStatusInput struct {
	PR int `json:"pr"`
}

// PRStateSignal drives the pr_status tracker via SignalPRState. It carries
// either an observed PR lifecycle state ("merged"/"closed", State != "") from
// the comment/inbox pollers, or an ingest-refresh request (State == "" &&
// HeadSHA != "") from pollIngestRefresh, when it observes a head SHA newer
// than what was last ingested. Both ride the same signal name because a
// workflow can only WaitSignal on one name at a time (mirrors
// ReactionSignal.Action / ApprovalSignal.Viewed).
type PRStateSignal struct {
	State   string `json:"state,omitempty"`
	BaseSHA string `json:"baseSHA,omitempty"` // ingest-refresh: newly observed base SHA
	HeadSHA string `json:"headSHA,omitempty"` // ingest-refresh: newly observed head SHA
}

// PRInboxInput starts the pr_inbox Workflow Execution for a repo.
type PRInboxInput struct {
	Repo string `json:"repo"`
}

// BuildRelationsInput starts (and re-signals) a build_relations Execution — one
// per PR.
type BuildRelationsInput struct {
	PR int `json:"pr"`
}

// ApproveInput starts an approve Execution — one tracker per PR.
type ApproveInput struct {
	PR int `json:"pr"`
}

// ApprovalSignal carries one block's full approved state into the approve
// tracker (delivered under SignalSet). Rows/Calls are the complete set for that
// block; an empty set clears the block's row from the read-model.
//
// It also doubles as a file-viewed request (File set, Viewed non-nil): the UI
// marks/unmarks a file's GitHub "Viewed" checkbox once all its top-level
// blocks are fully approved. Both ride the same "set" Signal because a
// workflow can only WaitSignal on one name at a time (mirrors ReactionSignal's
// Action-based multiplexing) — Viewed == nil means "ordinary block approval",
// non-nil means "file-viewed request" and BlockID/Rows/Calls are ignored.
type ApprovalSignal struct {
	BlockID string   `json:"blockId"`
	Rows    []int    `json:"rows"`
	Calls   []string `json:"calls"`
	File    string   `json:"file"`
	Viewed  *bool    `json:"viewed"`
}

// IgnoreInput starts an ignore Execution — one tracker per repo.
type IgnoreInput struct {
	Repo string `json:"repo"`
}

// IgnoreSignal carries one PR's ignore state into the ignore tracker (delivered
// under SignalIgnore). Until is an absolute Unix-ms expiry the UI computed (0 =
// forever); Clear = true un-ignores the PR (Until is ignored then). Both ride
// the same Signal because a workflow can only WaitSignal on one name at a time.
type IgnoreSignal struct {
	PR    int   `json:"pr"`
	Until int64 `json:"until"`
	Clear bool  `json:"clear"`
}

// ResolveCallInput starts a resolve_call Execution: it asks the LLM to resolve
// the given (Go-unresolved) call keys made by one caller block.
type ResolveCallInput struct {
	PR          int      `json:"pr"`
	CallerID    string   `json:"callerId"`
	CallerFile  string   `json:"callerFile"`
	CallerClass string   `json:"callerClass"`
	CallerName  string   `json:"callerName"`
	Calls       []string `json:"calls"`
}

// ResolveTestCoversInput starts a resolve_test_covers Execution: it asks the
// LLM which method of each named class the given test covers — only for
// classes a class-level-only annotation named (the Go analyzer's "unresolved"
// status).
type ResolveTestCoversInput struct {
	PR        int      `json:"pr"`
	TestID    string   `json:"testId"`
	TestFile  string   `json:"testFile"`
	TestClass string   `json:"testClass"`
	TestName  string   `json:"testName"`
	Classes   []string `json:"classes"`
}

// ExplainCodeInput starts an explain_code Execution: it asks Haiku to describe
// (in Dutch, 1-2 sentences) the if-statement inside one selected navigation
// unit. Everything the LLM sees travels in the input — the unit's code plus
// the surrounding block source — so the workflow body stays a pure function of
// its input (no worktree reads). UnitKey addresses the unit within the block
// in aligned-row space (`group-<start>-<end>` / `line-<row>`, the same codeRef
// shape as commentPath); CodeHash fingerprints Code+Context so a stale row is
// ignored by the frontend after the code changes.
type ExplainCodeInput struct {
	PR       int    `json:"pr"`
	BlockID  string `json:"blockId"`
	File     string `json:"file"`
	Label    string `json:"label"`
	Gran     string `json:"gran"`
	UnitKey  string `json:"unitKey"`
	CodeHash string `json:"codeHash"`
	Code     string `json:"code"`
	Context  string `json:"context"`
}

// IngestInput starts an ingest Workflow Execution for one PR.
type IngestInput struct {
	PR int `json:"pr"`
}

// SubmitReviewInput starts a submit_review Workflow Execution: submitting a
// real GitHub PR-level review. Event must be "APPROVE" or "REQUEST_CHANGES"
// (validated by validateSubmitReview before the workflow ever starts). Body
// may be empty for an APPROVE; GitHub itself rejects a bodyless
// REQUEST_CHANGES, which validateSubmitReview also rejects up front.
type SubmitReviewInput struct {
	PR    int    `json:"pr"`
	Event string `json:"event"`
	Body  string `json:"body"`
}

// ReadyForReviewInput starts a ready_for_review Workflow Execution: flip a
// draft PR to "ready for review" and optionally request reviewers. Reviewers
// is a list of user logins (validated by validateReadyForReview before the
// workflow starts); empty means "just mark ready".
type ReadyForReviewInput struct {
	PR        int      `json:"pr"`
	Reviewers []string `json:"reviewers"`
}

// CodeWarningInput starts a code_warning Execution: an agentic Sonnet review
// of a PR for risks. Files is reserved for a future incremental fast-follow
// (re-checking only the files a new commit touched, piggybacking on
// pr_status's ingest-refresh delta) — it is always empty today: the only
// caller (the "/" menu's "Controleer de hele PR op risico's") starts a full
// baseline run, and resolveWarningScope derives the scope itself from the
// PR's current blocks whenever Files is empty.
type CodeWarningInput struct {
	PR    int      `json:"pr"`
	Files []string `json:"files,omitempty"`
}

// warningScope is resolveWarningScope's Activity result: the files being
// (re-)checked this run and how many blocks they contain — the latter bounds
// how many findings the model may report (see codeWarningWorkflow).
type warningScope struct {
	Files      []string `json:"files"`
	BlockCount int      `json:"blockCount"`
}

// inboxRefreshResult is the small summary the refreshInbox Activity returns — the
// actual data lives in the inbox read-model, so the event history stays compact
// even though this workflow refreshes indefinitely.
type inboxRefreshResult struct {
	UpdatedAt string `json:"updatedAt"`
	PRs       int    `json:"prs"`
}

// TaskManager registers the workflows + their activities on a tembed engine and
// runs the per-execution GitHub poller.
type TaskManager struct {
	engine      *tembed.Engine
	gh          github.Client
	comments    *comments.Module
	inbox       *inbox.Module
	relations   *relations.Module
	prmeta      *prmeta.Module
	callresolve *callresolve.Module
	testcovers  *testcovers.Module
	approvals   *approvals.Module
	explain     *explanations.Module
	ignore      *ignore.Module
	// reviewerusage counts how often each reviewer was assigned through the
	// ready_for_review flow (most-used-first sorting of the picker). Set
	// post-construction in newTasks (not a NewTaskManager param) to avoid
	// churning every test call site; a nil store makes bumpReviewerUsage a
	// no-op, like the other module-guarded activities.
	reviewerusage *reviewerusage.Module
	claude        claude.Client
	jira          jira.Client
	db            *sql.DB
	dataDir       string
	repo          string
	interval      time.Duration // fast cadence (reviewer active)
	idle          time.Duration // slow cadence + PR-state check (reviewer idle)
	logf          func(string, ...any)

	// baseCtx is the server-lifetime context background pollers spawned outside
	// a request (e.g. ensurePRStatus's fresh-poller spawn) run under — a
	// request-scoped ctx would be cancelled the moment the handler that started
	// it returns. Set via SetRuntime; nil (and runtimeReady false) for a
	// one-shot CLI caller, which never spawns background pollers.
	baseCtx      context.Context
	runtimeReady bool

	mu           sync.Mutex           // guards lastBeat + prRuns + relRuns + apprRuns + inboxRun + ignoreRun + importPolled
	lastBeat     map[string]time.Time // code-comment/inbox Run ID → last heartbeat
	prRuns       map[int]string       // PR → pr_status Run ID
	relRuns      map[int]string       // PR → build_relations Run ID
	apprRuns     map[int]string       // PR → approve Run ID
	inboxRun     string               // pr_inbox Run ID (one per repo/process)
	ignoreRun    string               // ignore Run ID (one per repo/process)
	importPolled map[string]bool      // imported-thread Run ID → poller running (dedup, operational)
}

// NewTaskManager wires the modules onto engine and registers the workflows.
func NewTaskManager(engine *tembed.Engine, gh github.Client, cs *comments.Module, ib *inbox.Module, rel *relations.Module, pm *prmeta.Module, cr *callresolve.Module, tc *testcovers.Module, ap *approvals.Module, ex *explanations.Module, ig *ignore.Module, cl claude.Client, jr jira.Client, db *sql.DB, dataDir, repo string) *TaskManager {
	m := &TaskManager{
		engine: engine, gh: gh, comments: cs, inbox: ib, relations: rel, prmeta: pm, callresolve: cr, testcovers: tc, approvals: ap, explain: ex, ignore: ig, claude: cl, jira: jr, db: db, dataDir: dataDir, repo: repo,
		interval: pollInterval, idle: idlePollInterval,
		lastBeat: map[string]time.Time{}, prRuns: map[int]string{}, relRuns: map[int]string{}, apprRuns: map[int]string{},
		importPolled: map[string]bool{},
		logf:         log.Printf,
	}

	// Activity: fetch the inbox from GitHub and store it in the read-model
	// (write, workflow-driven). Best-effort: on a fetch failure we keep the last
	// good snapshot so the workflow never fails on a transient GitHub hiccup.
	engine.RegisterActivity("refreshInbox", func(ctx context.Context, in []byte) ([]byte, error) {
		snap, err := buildInboxSnapshot(ctx, m.db)
		if err != nil {
			m.logf("pr_inbox: refresh skipped: %v", err)
			return json.Marshal(inboxRefreshResult{})
		}
		sections, _ := json.Marshal(snap.Sections)
		statuses, _ := json.Marshal(snap.Statuses)
		updatedAt := time.Now().UTC().Format(time.RFC3339)
		if err := m.inbox.Save(ctx, inbox.Snapshot{
			Repo: m.repo, GeneratedFor: snap.GeneratedFor, UpdatedAt: updatedAt,
			Sections: sections, Statuses: statuses,
		}); err != nil {
			return nil, fmt.Errorf("save inbox: %w", err)
		}
		n := 0
		for _, s := range snap.Sections {
			n += len(s.PRs)
		}
		return json.Marshal(inboxRefreshResult{UpdatedAt: updatedAt, PRs: n})
	})

	// Activity: the comments module stores the comment (write, workflow-driven).
	engine.RegisterActivity("saveComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var c comments.Comment
		if err := json.Unmarshal(in, &c); err != nil {
			return nil, err
		}
		return nil, cs.Save(ctx, c)
	})

	// Activity: the github module posts the line comment (best-effort — a
	// failure must not sink the workflow, so local/no-gh runs still work).
	engine.RegisterActivity("postGithubComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var c CodeCommentInput
		if err := json.Unmarshal(in, &c); err != nil {
			return nil, err
		}
		start, end := c.StartLine, c.EndLine
		if start == 0 && end == 0 {
			start, end = c.Line, c.Line
		} else if end == 0 {
			end = c.Line
		}
		side := c.Side
		if side == "" {
			side = "RIGHT"
		}
		body := c.Body
		if c.Gran == "call" && c.Segment != "" {
			body = fmt.Sprintf("`%s`\n\n%s", c.Segment, body)
		}
		id, err := gh.PostReviewComment(ctx, c.PR, c.File, start, end, side, body)
		if err != nil {
			m.logf("task_code_comment: github post skipped: %v", err)
			return json.Marshal(postResult{RootID: 0})
		}
		return json.Marshal(postResult{RootID: id})
	})

	// Activity: the comments module stores a reaction (write, workflow-driven).
	engine.RegisterActivity("saveReaction", func(ctx context.Context, in []byte) ([]byte, error) {
		var r comments.Reaction
		if err := json.Unmarshal(in, &r); err != nil {
			return nil, err
		}
		return nil, cs.AddReaction(ctx, r)
	})

	// Activity: mark the comment as being deleted (write, workflow-driven). The
	// first step of the delete flow, so the UI can show "Aan het verwijderen"
	// while the actual removal (GitHub + the row itself) is still in flight.
	engine.RegisterActivity("markCommentDeleting", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.SetStatus(ctx, arg.ID, "deleting")
	})

	// Activity: delete the GitHub review comment (best-effort — a failure must
	// not block removing our own record of it).
	engine.RegisterActivity("deleteGithubComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR     int   `json:"pr"`
			RootID int64 `json:"rootId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if err := gh.DeleteComment(ctx, arg.PR, arg.RootID); err != nil {
			m.logf("task_code_comment: github delete skipped: %v", err)
		}
		return nil, nil
	})

	// Activity: the comments module removes the comment (write, workflow-driven)
	// — the final step of the delete flow, cascading its reactions.
	engine.RegisterActivity("deleteComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.Delete(ctx, arg.ID)
	})

	// Activity: reply on GitHub to a UI reaction (best-effort).
	engine.RegisterActivity("replyGithub", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR     int    `json:"pr"`
			RootID int64  `json:"rootId"`
			Body   string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if _, err := gh.Reply(ctx, arg.PR, arg.RootID, arg.Body); err != nil {
			m.logf("task_code_comment: github reply skipped: %v", err)
		}
		return nil, nil
	})

	// Activity: resolve ("Resolve conversation") the GitHub review-diff thread of
	// a comment when the reviewer resolves it in the app (best-effort). A PR-wide
	// thread has no GitHub resolve concept, so this is only called for review-diff
	// threads.
	engine.RegisterActivity("resolveGithubThread", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR     int   `json:"pr"`
			RootID int64 `json:"rootId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if err := gh.ResolveReviewThread(ctx, arg.PR, arg.RootID); err != nil {
			m.logf("task_code_comment: github resolve thread skipped: %v", err)
		}
		return nil, nil
	})

	// Activity: post a reply to a PR-wide (issue/review-summary) thread as a NEW
	// issue comment on the PR's flat conversation (best-effort). PR-wide comments
	// have no reply thread on GitHub, so this is how a reply is mirrored. Returns
	// the new comment's ID (as a postResult) so it's recorded in history —
	// importPRComments reads that to skip re-importing the app's own reply as a
	// separate root (knownGithubIDs).
	engine.RegisterActivity("postGithubIssueComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR   int    `json:"pr"`
			Body string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		id, err := gh.PostIssueComment(ctx, arg.PR, arg.Body)
		if err != nil {
			m.logf("task_code_comment: github issue comment skipped: %v", err)
			return json.Marshal(postResult{})
		}
		return json.Marshal(postResult{RootID: id})
	})

	// Activity: fetch the PR's meta, ensure its commits are locally reachable, and
	// materialize the base/head git worktrees (write — creates worktrees on disk).
	// Returns only the two SHAs + changed file paths, not the worktree contents.
	engine.RegisterActivity("prepareWorktrees", func(ctx context.Context, in []byte) ([]byte, error) {
		var input IngestInput
		if err := json.Unmarshal(in, &input); err != nil {
			return nil, err
		}
		setIngestStage(input.PR, IngestStageWorktrees)
		defer clearIngestStage(input.PR)
		shas, err := prepareIngestWorktrees(ctx, m.dataDir, input.PR)
		if err != nil {
			return nil, fmt.Errorf("ingest: prepare worktrees: %w", err)
		}
		return json.Marshal(shas)
	})

	// Activity: diff the two worktrees, parse+classify the touched PHP files, and
	// full-swap the resulting blocks into the DB (write — the only writer of the
	// blocks table). Returns only the small ingestResult summary, not the blocks
	// themselves, so the workflow history stays compact.
	engine.RegisterActivity("scanAndStoreBlocks", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR   int          `json:"pr"`
			Shas worktreeSHAs `json:"shas"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		setIngestStage(arg.PR, IngestStageScan)
		defer clearIngestStage(arg.PR)
		res, err := scanAndStoreIngestBlocks(ctx, m.db, m.dataDir, arg.PR, arg.Shas)
		if err != nil {
			return nil, fmt.Errorf("ingest: scan and store blocks: %w", err)
		}
		return json.Marshal(res)
	})

	// Activity: incrementally refresh a PR's blocks after new commits landed on
	// its head ref (write — scoped to just the changed files via
	// upsertPRFileBlocks; falls back to a full ingest if the base SHA itself
	// moved). Driven by pr_status's SignalPRState branch, on the ingest-refresh
	// poller's cadence (pollIngestRefresh).
	engine.RegisterActivity("refreshIngestDelta", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR      int    `json:"pr"`
			BaseSHA string `json:"baseSHA"`
			HeadSHA string `json:"headSHA"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		res, err := refreshIngestDelta(ctx, m.db, m.dataDir, arg.PR, arg.BaseSHA, arg.HeadSHA)
		if err != nil {
			return nil, fmt.Errorf("pr_status: refresh ingest delta: %w", err)
		}
		return json.Marshal(res)
	})

	// Activity: analyse the PR's blocks into relations and store them (write,
	// workflow-driven). Reads the head worktree; the relations module is the only
	// writer of the relations read-model.
	engine.RegisterActivity("buildRelations", func(ctx context.Context, in []byte) ([]byte, error) {
		var input BuildRelationsInput
		if err := json.Unmarshal(in, &input); err != nil {
			return nil, err
		}
		setIngestStage(input.PR, IngestStageRelations)
		defer clearIngestStage(input.PR)
		blocks, err := blocksByPR(m.db, input.PR)
		if err != nil {
			return nil, fmt.Errorf("build_relations: load blocks: %w", err)
		}
		rels := buildRelations(m.dataDir, input.PR, blocks)
		if err := m.relations.Replace(ctx, input.PR, rels); err != nil {
			return nil, fmt.Errorf("build_relations: save: %w", err)
		}
		// Also resolve method calls statically (resolved/unresolved) into the
		// callresolve read-model. UpsertGo preserves LLM-owned rows. A changed
		// migration's Schema::create/table → model mapping (resolveMigrationModels)
		// and a test's #[DataProvider(...)]/@dataProvider annotation
		// (resolveDataProviders, see .claude/rules/tembed-workflows.md, "PHPUnit
		// data providers") ride the same read-model/keep-set (see
		// .claude/rules/tembed-workflows.md, "migration → model") so their rows
		// are never pruned as stale.
		calls := resolveCalls(m.dataDir, input.PR, blocks)
		calls = append(calls, resolveMigrationModels(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveDataProviders(m.dataDir, input.PR, blocks)...)
		if m.callresolve != nil {
			if err := m.callresolve.UpsertGo(ctx, calls); err != nil {
				return nil, fmt.Errorf("build_relations: save calls: %w", err)
			}
			// Drop stale rows: every (caller, call) pair the scan no longer emits —
			// the caller block left the PR, or the call site is no longer on a
			// changed line.
			if err := m.callresolve.Prune(ctx, input.PR, calls); err != nil {
				return nil, fmt.Errorf("build_relations: prune calls: %w", err)
			}
		}
		// Also detect test-coverage annotations statically (resolved/unannotated/
		// unresolved) into the testcovers read-model. UpsertGo preserves LLM-owned
		// rows (searching/found/notfound).
		covers := scanTestCovers(m.dataDir, input.PR, blocks)
		if m.testcovers != nil {
			if err := m.testcovers.UpsertGo(ctx, covers); err != nil {
				return nil, fmt.Errorf("build_relations: save test covers: %w", err)
			}
			if err := m.testcovers.Prune(ctx, input.PR, covers); err != nil {
				return nil, fmt.Errorf("build_relations: prune test covers: %w", err)
			}
		}
		return json.Marshal(map[string]int{"relations": len(rels), "calls": len(calls), "covers": len(covers)})
	})

	// Activity: mark a caller's calls as being searched (write, workflow-driven).
	engine.RegisterActivity("markCallsSearching", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ResolveCallInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.callresolve == nil {
			return nil, nil
		}
		return nil, m.callresolve.SaveSearching(ctx, arg.PR, arg.CallerID, arg.Calls)
	})

	// Activity: resolve calls with one LLM model (Haiku = context-only shortlist,
	// Sonnet = agentic worktree search). Reads the head worktree + shells out to
	// the claude CLI — a side effect, hence an Activity. Returns one entry per call
	// (found/notfound, verified against the worktree).
	engine.RegisterActivity("resolveWithModel", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg resolveArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		entries := resolveCallsWithModel(ctx, m.claude, m.dataDir, arg)
		return json.Marshal(entries)
	})

	// Activity: persist the final LLM resolutions (write, workflow-driven).
	engine.RegisterActivity("saveResolutions", func(ctx context.Context, in []byte) ([]byte, error) {
		var entries []callresolve.Entry
		if err := json.Unmarshal(in, &entries); err != nil {
			return nil, err
		}
		if m.callresolve == nil {
			return nil, nil
		}
		for _, e := range entries {
			if err := m.callresolve.Save(ctx, e); err != nil {
				return nil, err
			}
		}
		return json.Marshal(map[string]int{"saved": len(entries)})
	})

	// Activity: mark a test's class-level-only targets as being searched
	// (write, workflow-driven).
	engine.RegisterActivity("markTestCoversSearching", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ResolveTestCoversInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.testcovers == nil {
			return nil, nil
		}
		keys := make([]string, len(arg.Classes))
		for i, c := range arg.Classes {
			keys[i] = "class:" + shortName(c)
		}
		return nil, m.testcovers.SaveSearching(ctx, arg.PR, arg.TestID, keys)
	})

	// Activity: look for a sibling test (same PR + same test file, different
	// test_id) that already resolved the same covered class, so the workflow
	// can skip Haiku for that class entirely. Reads the testcovers read-model
	// (a side effect, hence an Activity) and delegates the actual matching to
	// the pure reuseSiblingCovers.
	engine.RegisterActivity("reuseTestCoverSiblings", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg testCoverReuseArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.testcovers == nil {
			return json.Marshal(testCoverReuseResult{Remaining: arg.Classes})
		}
		entries, err := m.testcovers.List(ctx, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("resolve_test_covers: list siblings: %w", err)
		}
		return json.Marshal(reuseSiblingCovers(entries, arg))
	})

	// Activity: resolve which method of each named class a test covers, with
	// one LLM model (Haiku = context-only shortlist, Sonnet = agentic worktree
	// search). Reads the head worktree + shells out to the claude CLI — a side
	// effect, hence an Activity. Returns one entry per class (found/notfound,
	// verified against the worktree).
	engine.RegisterActivity("resolveTestCoversWithModel", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg testCoverArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		entries := resolveTestCoversWithModel(ctx, m.claude, m.dataDir, arg)
		return json.Marshal(entries)
	})

	// Activity: persist the final LLM test-coverage resolutions (write,
	// workflow-driven).
	engine.RegisterActivity("saveTestCoverResolutions", func(ctx context.Context, in []byte) ([]byte, error) {
		var entries []testcovers.Entry
		if err := json.Unmarshal(in, &entries); err != nil {
			return nil, err
		}
		if m.testcovers == nil {
			return nil, nil
		}
		for _, e := range entries {
			if err := m.testcovers.Save(ctx, e); err != nil {
				return nil, err
			}
		}
		return json.Marshal(map[string]int{"saved": len(entries)})
	})

	// Activity: mark a unit's explanation as in-progress in the explanations
	// read-model (write, workflow-driven).
	engine.RegisterActivity("markExplainSearching", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ExplainCodeInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.explain == nil {
			return nil, nil
		}
		return nil, m.explain.SaveSearching(ctx, explanations.Entry{
			PR: arg.PR, BlockID: arg.BlockID, UnitKey: arg.UnitKey, CodeHash: arg.CodeHash,
		})
	})

	// Activity: ask Haiku (context-only, no tools — everything it needs travels
	// in the input) for a short Dutch description of the unit's if-statement.
	// Shells out to the claude CLI — a side effect, hence an Activity. Best-effort:
	// a Claude hiccup yields empty text (the workflow then records "failed")
	// rather than sinking the run.
	engine.RegisterActivity("generateExplanation", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ExplainCodeInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.claude == nil {
			return json.Marshal(map[string]string{"text": ""})
		}
		text, err := m.claude.Run(ctx, claude.RunRequest{
			Prompt:       explainPrompt(arg),
			Model:        claude.ModelHaiku,
			SystemPrompt: claude.ExplainCodeSystemPrompt,
		})
		if err != nil {
			m.logf("explain_code: generate pr=%d %s/%s skipped: %v", arg.PR, arg.BlockID, arg.UnitKey, err)
			text = ""
		}
		return json.Marshal(map[string]string{"text": strings.TrimSpace(text)})
	})

	// Activity: persist the finished explanation (write, workflow-driven).
	engine.RegisterActivity("saveExplanation", func(ctx context.Context, in []byte) ([]byte, error) {
		var e explanations.Entry
		if err := json.Unmarshal(in, &e); err != nil {
			return nil, err
		}
		if m.explain == nil {
			return nil, nil
		}
		return nil, m.explain.Save(ctx, e)
	})

	// Activity: stage 1 of the pr_status tracker — fetch the PR's basics (title,
	// URL, body, author, diff-stats, head ref) from GitHub, derive a Jira key from
	// the title and fetch that issue (best-effort), then store all of it in the
	// prmeta read-model (write, workflow-driven). A GitHub/Jira hiccup or a nil
	// store (tests) must not sink the pr_status tracker.
	engine.RegisterActivity("fetchPRBasics", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PRStatusInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prmeta == nil {
			return nil, nil
		}
		meta, err := gh.PRMeta(ctx, arg.PR)
		if err != nil {
			m.logf("pr_status: fetch basics pr=%d skipped: %v", arg.PR, err)
			return nil, nil
		}
		out := prmeta.Meta{
			PR: arg.PR, Title: meta.Title, URL: meta.URL, Body: meta.Body, Author: meta.Author,
			Additions: meta.Additions, Deletions: meta.Deletions, ChangedFiles: meta.ChangedFiles,
			HeadRef: meta.HeadRef,
		}
		if key := jiraKeyFromTitle(meta.Title); key != "" && m.jira != nil {
			issue, err := m.jira.Issue(ctx, key)
			if err != nil {
				m.logf("pr_status: fetch jira %s skipped: %v", key, err)
			} else {
				out.JiraKey = key
				out.JiraTitle = issue.Title
				out.JiraDesc = issue.Description
				out.JiraURL = issue.URL
			}
		}
		if err := m.prmeta.SaveBasics(ctx, out); err != nil {
			return nil, fmt.Errorf("save pr basics: %w", err)
		}
		return nil, nil
	})

	// Activity: stage 2 of the pr_status tracker — ask Haiku for a short summary
	// of the PR (title + body + changed files + linked Jira issue) and store it.
	// Best-effort: a Claude hiccup or missing stores must not sink the tracker.
	engine.RegisterActivity("generatePRSummary", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PRStatusInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prmeta == nil || m.claude == nil {
			return nil, nil
		}
		meta, ok, err := m.prmeta.Get(ctx, arg.PR)
		if err != nil || !ok {
			return nil, nil
		}
		files, _ := changedFilesFor(m.db, arg.PR)
		prompt := prSummaryPrompt(meta, files)
		summary, err := m.claude.Run(ctx, claude.RunRequest{
			Prompt:       prompt,
			Model:        claude.ModelHaiku,
			SystemPrompt: claude.PRSummarySystemPrompt,
		})
		if err != nil {
			m.logf("pr_status: summary pr=%d skipped: %v", arg.PR, err)
			return nil, nil
		}
		if err := m.prmeta.SaveSummary(ctx, arg.PR, strings.TrimSpace(summary)); err != nil {
			return nil, fmt.Errorf("save pr summary: %w", err)
		}
		return nil, nil
	})

	// Activity: stage 3 of the pr_status tracker — fetch the review decision + CI
	// checks + reviewers via the same heavy inbox query the overview uses, and
	// store them. Best-effort: a GitHub hiccup must not sink the tracker.
	engine.RegisterActivity("fetchPRStatuses", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PRStatusInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prmeta == nil || ghDisabled() {
			return nil, nil
		}
		statuses, err := statusesFor(ctx, []int{arg.PR})
		if err != nil {
			m.logf("pr_status: fetch statuses pr=%d skipped: %v", arg.PR, err)
			return nil, nil
		}
		st, ok := statuses[strconv.Itoa(arg.PR)]
		if !ok {
			return nil, nil
		}
		reviewers := make([]string, 0, len(st.Reviewers))
		for _, r := range st.Reviewers {
			reviewers = append(reviewers, r.Login)
		}
		// The heavy query only reports an overall rollup state, not a per-check
		// pass count; treat a SUCCESS rollup as "all passed", anything else as
		// "none confirmed passed yet" — good enough for a status pill.
		checksPassed := 0
		if st.ChecksState == "SUCCESS" {
			checksPassed = st.ChecksTotal
		}
		if err := m.prmeta.SaveStatuses(ctx, arg.PR, st.ReviewDecision, st.ChecksTotal, checksPassed, reviewers); err != nil {
			return nil, fmt.Errorf("save pr statuses: %w", err)
		}
		return nil, nil
	})

	// Activity: persist one block's full approved state (write, workflow-driven).
	// The approvals module is the only writer of the approvals read-model.
	engine.RegisterActivity("saveApproval", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR      int      `json:"pr"`
			BlockID string   `json:"blockId"`
			Rows    []int    `json:"rows"`
			Calls   []string `json:"calls"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.approvals == nil {
			return nil, nil
		}
		return nil, m.approvals.Replace(ctx, arg.PR, arg.BlockID, arg.Rows, arg.Calls)
	})

	// Activity: persist one PR's ignore state (write, workflow-driven). The
	// ignore module is the only writer of the ignore read-model. Until < 0
	// (Clear) deletes the row (un-ignore); the workflow computes that from the
	// signal so this Activity input stays a plain absolute value.
	engine.RegisterActivity("saveIgnore", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo  string `json:"repo"`
			PR    int    `json:"pr"`
			Until int64  `json:"until"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.ignore == nil {
			return nil, nil
		}
		return nil, m.ignore.Set(ctx, arg.Repo, arg.PR, arg.Until)
	})

	// Activity: mark/unmark a file's GitHub "Viewed" checkbox (write,
	// workflow-driven — the only place that talks to GitHub for this).
	engine.RegisterActivity("setFileViewed", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR     int    `json:"pr"`
			File   string `json:"file"`
			Viewed bool   `json:"viewed"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.gh == nil || arg.File == "" {
			return nil, nil
		}
		return nil, m.gh.MarkFileViewed(ctx, arg.PR, arg.File, arg.Viewed)
	})

	// Activity: submit a real GitHub PR-level review (write, workflow-driven —
	// the only place that talks to GitHub for this). Not best-effort: a failed
	// submission must surface as a real error, so the reviewer knows their
	// approve/request-changes did not land.
	engine.RegisterActivity("submitGithubReview", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg SubmitReviewInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.gh == nil {
			return nil, fmt.Errorf("submit review: no github client")
		}
		return nil, m.gh.SubmitReview(ctx, arg.PR, arg.Event, arg.Body)
	})

	// Activities for ready_for_review (write, workflow-driven): flip a draft PR
	// to ready, request reviewers, and bump the local usage counts. Not
	// best-effort — a failed GitHub call must surface to the reviewer.
	engine.RegisterActivity("markReadyForReview", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ReadyForReviewInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.gh == nil {
			return nil, fmt.Errorf("ready for review: no github client")
		}
		return nil, m.gh.MarkReadyForReview(ctx, arg.PR)
	})
	engine.RegisterActivity("requestReviewers", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ReadyForReviewInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.gh == nil {
			return nil, fmt.Errorf("request reviewers: no github client")
		}
		return nil, m.gh.RequestReviewers(ctx, arg.PR, arg.Reviewers)
	})
	engine.RegisterActivity("bumpReviewerUsage", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ReadyForReviewInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.reviewerusage == nil {
			return nil, nil
		}
		return nil, m.reviewerusage.Bump(ctx, m.repo, arg.Reviewers)
	})

	// Activity: resolve the code_warning scope — read (write-free) — reads the
	// PR's current blocks from the DB. Files empty in the input means "the
	// whole PR": derive the changed-file scope from the blocks themselves;
	// Files non-empty (the reserved incremental path, unused today) is passed
	// through unchanged. BlockCount is the number of blocks across the scope
	// files, which bounds how many findings the model may report (see
	// codeWarningWorkflow: warningsPerBlock findings on average).
	engine.RegisterActivity("resolveWarningScope", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg CodeWarningInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.db == nil {
			return json.Marshal(warningScope{})
		}
		blocks, err := blocksByPR(m.db, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: load blocks: %w", err)
		}
		files := arg.Files
		if len(files) == 0 {
			files = distinctSortedFiles(blocks)
		}
		fileSet := make(map[string]bool, len(files))
		for _, f := range files {
			fileSet[f] = true
		}
		count := 0
		for _, b := range blocks {
			if fileSet[b.File] {
				count++
			}
		}
		return json.Marshal(warningScope{Files: files, BlockCount: count})
	})

	// Activity: supersede — delete, via the existing delete Signal — every
	// AI-sourced warning comment (Source "ai") anchored to a file in scope,
	// before the fresh review creates new ones for those same files. Reads
	// the comments read-model (a side effect, hence an Activity) and signals
	// each stale run's own task_code_comment Execution; best-effort per
	// comment (a run that already resolved/closed itself can't be signalled
	// again — that must not sink the rest of the supersede).
	engine.RegisterActivity("supersedeFileWarnings", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			PR    int      `json:"pr"`
			Files []string `json:"files"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		fileSet := make(map[string]bool, len(arg.Files))
		for _, f := range arg.Files {
			fileSet[f] = true
		}
		list, err := cs.List(ctx, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: list comments: %w", err)
		}
		removed := 0
		for _, c := range list {
			if c.Source != "ai" || !fileSet[c.File] {
				continue
			}
			if err := m.Signal(c.RunID, ReactionSignal{
				ID: "sys-" + newUIReactionID(), Source: "ai", Action: "delete",
			}); err != nil {
				m.logf("code_warning: supersede delete skipped for %s: %v", c.RunID, err)
				continue
			}
			removed++
		}
		return json.Marshal(map[string]int{"removed": removed})
	})

	// Activity: the one agentic Sonnet call — reads the head worktree +
	// shells out to the claude CLI (a side effect, hence an Activity) — and
	// maps every accepted finding onto the existing comment-anchoring model
	// (anchoredWarning, code_warning.go), ready to hand to createWarningComment.
	engine.RegisterActivity("runAgenticReview", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg warningReviewArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		findings := runCodeWarningReview(ctx, m.claude, m.dataDir, arg)
		if len(findings) == 0 {
			return json.Marshal([]CodeCommentInput{})
		}
		blocks, err := blocksByPR(m.db, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: load blocks: %w", err)
		}
		out := make([]CodeCommentInput, 0, len(findings))
		for _, f := range findings {
			out = append(out, anchoredWarning(m.dataDir, arg.PR, blocks, f))
		}
		return json.Marshal(out)
	})

	// Activity: create one AI-authored warning comment (write, workflow-driven)
	// by starting a normal task_code_comment Execution — Source "ai" + Local
	// true (never posted to GitHub) — reusing the exact same sanctioned write
	// path a UI-placed comment uses.
	engine.RegisterActivity("createWarningComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var cc CodeCommentInput
		if err := json.Unmarshal(in, &cc); err != nil {
			return nil, err
		}
		runID, err := m.StartCodeComment(ctx, cc)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]string{"runId": runID})
	})

	engine.RegisterWorkflow(WorkflowTaskCodeComment, taskCodeCommentWorkflow)
	engine.RegisterWorkflow(WorkflowPRStatus, prStatusWorkflow)
	engine.RegisterWorkflow(WorkflowPRInbox, prInboxWorkflow)
	engine.RegisterWorkflow(WorkflowBuildRelations, buildRelationsWorkflow)
	engine.RegisterWorkflow(WorkflowIngest, ingestWorkflow)
	engine.RegisterWorkflow(WorkflowResolveCall, resolveCallWorkflow)
	engine.RegisterWorkflow(WorkflowResolveTestCovers, resolveTestCoversWorkflow)
	engine.RegisterWorkflow(WorkflowExplainCode, explainCodeWorkflow)
	engine.RegisterWorkflow(WorkflowApprove, approveWorkflow)
	engine.RegisterWorkflow(WorkflowSubmitReview, submitReviewWorkflow)
	engine.RegisterWorkflow(WorkflowReadyForReview, readyForReviewWorkflow)
	engine.RegisterWorkflow(WorkflowCodeWarning, codeWarningWorkflow)
	engine.RegisterWorkflow(WorkflowIgnore, ignoreWorkflow)
	return m
}

// distinctSortedFiles returns the distinct File values across blocks, sorted —
// resolveWarningScope's "whole PR" fallback when CodeWarningInput.Files is empty.
func distinctSortedFiles(blocks []Block) []string {
	seen := map[string]bool{}
	var files []string
	for _, b := range blocks {
		if !seen[b.File] {
			seen[b.File] = true
			files = append(files, b.File)
		}
	}
	sort.Strings(files)
	return files
}

// SetRuntime records the server-lifetime context and whether background
// pollers may run. newTasks calls this once, right after NewTaskManager,
// passing resumeRuntime — a one-shot CLI caller (e.g. `slash ingest`) passes
// false, so ensurePRStatus never spawns a pollIngestRefresh goroutine that
// would outlive a one-shot process pointlessly. ctx is the long-lived context
// background pollers run under (never a per-request context, which would be
// cancelled the moment the handler that started them returns).
func (m *TaskManager) SetRuntime(ctx context.Context, ready bool) {
	m.baseCtx = ctx
	m.runtimeReady = ready
}

// prInboxWorkflow owns the PR inbox for a repo. It is deterministic: each
// "refresh" Signal drives one refreshInbox Activity (the only GitHub read for
// the overview, which writes the read-model). It never completes — a long-lived
// tracker that re-fetches whenever signalled.
func prInboxWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	for {
		var s json.RawMessage
		w.WaitSignal(SignalRefresh, &s)
		var res inboxRefreshResult
		if err := w.ExecuteActivity("refreshInbox", PRInboxInput{}, &res); err != nil {
			return nil, fmt.Errorf("refresh inbox: %w", err)
		}
	}
}

// buildRelationsWorkflow derives a PR's block relations. It is deterministic:
// the build (which reads the worktree + writes the read-model) is an Activity.
// It builds once on start, then rebuilds on each "rebuild" Signal (re-ingest),
// so it stays a long-lived per-PR tracker we can extend with more detectors.
func buildRelationsWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in BuildRelationsInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("buildRelations", in, nil); err != nil {
		return nil, fmt.Errorf("build relations: %w", err)
	}
	for {
		var s json.RawMessage
		w.WaitSignal(SignalRebuild, &s)
		if err := w.ExecuteActivity("buildRelations", in, nil); err != nil {
			return nil, fmt.Errorf("rebuild relations: %w", err)
		}
	}
}

// ingestWorkflow runs the ingest pipeline for a PR. It is deterministic: all
// side effects (gh fetch, git worktrees, diff/parse, the blocks-table write)
// live in its two Activities, run in a fixed order. It completes once done —
// no signals, one Execution per ingest request.
func ingestWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in IngestInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}

	var shas worktreeSHAs
	if err := w.ExecuteActivity("prepareWorktrees", in, &shas); err != nil {
		return nil, fmt.Errorf("prepare worktrees: %w", err)
	}

	var res ingestResult
	arg := struct {
		PR   int          `json:"pr"`
		Shas worktreeSHAs `json:"shas"`
	}{PR: in.PR, Shas: shas}
	if err := w.ExecuteActivity("scanAndStoreBlocks", arg, &res); err != nil {
		return nil, fmt.Errorf("scan and store blocks: %w", err)
	}
	return json.Marshal(res)
}

// StartIngest runs the ingest Workflow Execution for pr to completion
// (StartWorkflow drives a signal-less workflow synchronously) and returns its
// result summary. Starting an Execution is the sanctioned write path — this is
// the only way blocks/worktrees are written.
func (m *TaskManager) StartIngest(ctx context.Context, pr int) (*ingestResult, error) {
	runID, err := m.engine.StartWorkflow(WorkflowIngest, IngestInput{PR: pr})
	if err != nil {
		return nil, err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return nil, err
	}
	if status == tembed.StatusFailed {
		return nil, fmt.Errorf("ingest failed (run %s)", runID)
	}
	var res ingestResult
	if err := m.engine.Result(runID, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// submitReviewWorkflow submits one GitHub PR-level review (approve or request
// changes). It is deterministic: the only side effect (gh api
// pulls/{pr}/reviews) is its one Activity, run once, in a fixed order — no
// signals, one Execution per submit request, mirrors ingestWorkflow.
func submitReviewWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in SubmitReviewInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("submitGithubReview", in, nil); err != nil {
		return nil, fmt.Errorf("submit review: %w", err)
	}
	return json.Marshal(map[string]any{"pr": in.PR, "event": in.Event})
}

// StartSubmitReview runs the submit_review Workflow Execution for in to
// completion (StartWorkflow drives a signal-less workflow synchronously) and
// returns its Run ID. Starting an Execution is the sanctioned write path —
// this is the only way a real GitHub PR-level review gets submitted. Unlike
// resolve_call/explain_code (best-effort LLM lookups that never fail the
// caller), a failed GitHub submission must reach the caller as an error —
// mirrors StartIngest's status check.
func (m *TaskManager) StartSubmitReview(in SubmitReviewInput) (string, error) {
	runID, err := m.engine.StartWorkflow(WorkflowSubmitReview, in)
	if err != nil {
		return "", err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return runID, err
	}
	if status == tembed.StatusFailed {
		return runID, fmt.Errorf("submit review failed (run %s)", runID)
	}
	return runID, nil
}

// readyForReviewWorkflow flips a draft PR to ready-for-review, optionally
// requests reviewers, and bumps the local usage counts. It is deterministic:
// every side effect is an Activity run in a fixed order; the reviewer
// Activities only run when Reviewers is non-empty (a function of the input),
// so replay is stable. No signal — it runs straight through and completes,
// mirroring submitReviewWorkflow.
func readyForReviewWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ReadyForReviewInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("markReadyForReview", in, nil); err != nil {
		return nil, fmt.Errorf("mark ready for review: %w", err)
	}
	if len(in.Reviewers) > 0 {
		if err := w.ExecuteActivity("requestReviewers", in, nil); err != nil {
			return nil, fmt.Errorf("request reviewers: %w", err)
		}
		if err := w.ExecuteActivity("bumpReviewerUsage", in, nil); err != nil {
			return nil, fmt.Errorf("bump reviewer usage: %w", err)
		}
	}
	return json.Marshal(map[string]any{"pr": in.PR, "reviewers": in.Reviewers})
}

// StartReadyForReview runs the ready_for_review Workflow Execution to
// completion (a signal-less workflow runs synchronously) and returns its Run
// ID. Starting an Execution is the sanctioned write path; a failed GitHub call
// reaches the caller as an error, mirroring StartSubmitReview.
func (m *TaskManager) StartReadyForReview(in ReadyForReviewInput) (string, error) {
	runID, err := m.engine.StartWorkflow(WorkflowReadyForReview, in)
	if err != nil {
		return "", err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return runID, err
	}
	if status == tembed.StatusFailed {
		return runID, fmt.Errorf("ready for review failed (run %s)", runID)
	}
	return runID, nil
}

// ReviewerCandidate is one candidate reviewer for the picker: a repo
// collaborator with its local usage count (0 = never assigned through this
// feature). READ-only view — no state is mutated by building it.
type ReviewerCandidate struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
	Count     int    `json:"count"`
}

// Reviewers returns the repo's collaborators as reviewer candidates, sorted
// most-used-first (by the local reviewer-usage counts), ties and never-used
// collaborators broken alphabetically. Read — both the github collaborator
// fetch and the usage List are read methods, so this is safe outside a
// workflow (it mutates nothing).
func (m *TaskManager) Reviewers(ctx context.Context) ([]ReviewerCandidate, error) {
	if m.gh == nil {
		return nil, fmt.Errorf("reviewers: no github client")
	}
	collabs, err := m.gh.ListCollaborators(ctx)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	if m.reviewerusage != nil {
		usage, err := m.reviewerusage.List(ctx, m.repo)
		if err != nil {
			return nil, err
		}
		for _, u := range usage {
			counts[u.Login] = u.Count
		}
	}
	out := make([]ReviewerCandidate, 0, len(collabs))
	for _, c := range collabs {
		out = append(out, ReviewerCandidate{Login: c.Login, AvatarURL: c.AvatarURL, Count: counts[c.Login]})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Login < out[j].Login
	})
	return out, nil
}

// warningsPerBlock bounds codeWarningWorkflow's finding cap: on average about
// this many findings per block in scope (never a fixed count), per the "per
// blok gemiddeld maximaal ~2 warnings" decision — quality over quantity. The
// model is also told this bound in the prompt (warningPrompt), but the cap is
// re-enforced in Go (runCodeWarningReview trims the sorted list), so a model
// that ignores the instruction can never blow past it.
const warningsPerBlock = 2

// codeWarningWorkflow agentically reviews a PR's changed files for risks. It
// is deterministic: every side effect (the DB reads, the Sonnet call, the
// comment reads/deletes/creates) is an Activity, run in a fixed order, and the
// number of createWarningComment calls is exactly len(findings) — a function
// of runAgenticReview's own (already-recorded) result, so it replays safely.
// No signal — it runs straight through and completes, mirroring
// submitReviewWorkflow/ingestWorkflow.
func codeWarningWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in CodeWarningInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}

	var scope warningScope
	if err := w.ExecuteActivity("resolveWarningScope", in, &scope); err != nil {
		return nil, fmt.Errorf("resolve warning scope: %w", err)
	}
	if len(scope.Files) == 0 {
		return json.Marshal(map[string]int{"found": 0})
	}

	if err := w.ExecuteActivity("supersedeFileWarnings", map[string]any{
		"pr": in.PR, "files": scope.Files,
	}, nil); err != nil {
		return nil, fmt.Errorf("supersede file warnings: %w", err)
	}

	maxFindings := scope.BlockCount * warningsPerBlock
	if maxFindings < warningsPerBlock {
		maxFindings = warningsPerBlock
	}
	var toCreate []CodeCommentInput
	if err := w.ExecuteActivity("runAgenticReview", warningReviewArg{
		PR: in.PR, Files: scope.Files, BlockCount: scope.BlockCount, MaxFindings: maxFindings,
	}, &toCreate); err != nil {
		return nil, fmt.Errorf("run agentic review: %w", err)
	}

	for _, cc := range toCreate {
		if err := w.ExecuteActivity("createWarningComment", cc, nil); err != nil {
			return nil, fmt.Errorf("create warning comment: %w", err)
		}
	}
	return json.Marshal(map[string]int{"found": len(toCreate)})
}

// StartCodeWarning launches a code_warning Execution and runs it to
// completion (StartWorkflow drives a signal-less workflow synchronously),
// returning its Run ID. Starting an Execution is the sanctioned write path.
// Unlike explain_code's content-keyed idempotent start, this is a plain
// StartWorkflow: each manual "Controleer de hele PR op risico's" click is a
// deliberate, repeatable refresh — supersedeFileWarnings already replaces the
// previous run's findings for the files in scope, so re-running is "refresh
// the risk check", not "duplicate it".
func (m *TaskManager) StartCodeWarning(in CodeWarningInput) (string, error) {
	return m.engine.StartWorkflow(WorkflowCodeWarning, in)
}

// approveWorkflow persists reviewer approval for a PR. It is deterministic: the
// only side effect (the read-model write) is an Activity, and the number of
// Activities is exactly the number of "set" Signals in the history. It never
// completes — a long-lived per-PR tracker that records each block's approved
// state as it is toggled.
func approveWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ApproveInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var sig ApprovalSignal
		w.WaitSignal(SignalSet, &sig)
		if sig.Viewed != nil {
			arg := struct {
				PR     int    `json:"pr"`
				File   string `json:"file"`
				Viewed bool   `json:"viewed"`
			}{PR: in.PR, File: sig.File, Viewed: *sig.Viewed}
			if err := w.ExecuteActivity("setFileViewed", arg, nil); err != nil {
				return nil, fmt.Errorf("set file viewed: %w", err)
			}
			continue
		}
		arg := struct {
			PR      int      `json:"pr"`
			BlockID string   `json:"blockId"`
			Rows    []int    `json:"rows"`
			Calls   []string `json:"calls"`
		}{PR: in.PR, BlockID: sig.BlockID, Rows: sig.Rows, Calls: sig.Calls}
		if err := w.ExecuteActivity("saveApproval", arg, nil); err != nil {
			return nil, fmt.Errorf("save approval: %w", err)
		}
	}
}

// ignoreWorkflow persists which PRs are ignored (hidden from the inbox) for a
// repo. It is deterministic: the only side effect (the read-model write) is an
// Activity, the number of Activities is exactly the number of "ignore" Signals
// in the history, and the expiry is an absolute value carried in the signal (the
// UI computed it) — the body never reads a clock. It never completes: a
// long-lived per-repo tracker recording each ignore/un-ignore as it happens.
func ignoreWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in IgnoreInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var sig IgnoreSignal
		w.WaitSignal(SignalIgnore, &sig)
		until := sig.Until
		if sig.Clear {
			until = -1 // Set(...) deletes the row on a negative expiry
		}
		arg := struct {
			Repo  string `json:"repo"`
			PR    int    `json:"pr"`
			Until int64  `json:"until"`
		}{Repo: in.Repo, PR: sig.PR, Until: until}
		if err := w.ExecuteActivity("saveIgnore", arg, nil); err != nil {
			return nil, fmt.Errorf("save ignore: %w", err)
		}
	}
}

// resolveCallWorkflow resolves a caller's Go-unresolved method calls with the
// LLM. It is deterministic: the LLM/worktree work is in a single Activity, run
// once per call to completion. It uses ONLY Haiku (context-only) — no automatic
// Sonnet escalation. The generic Sonnet/agentic machinery in resolve_call.go
// still exists (resolveArg.Model, the agentic prompt branch) but this workflow
// never invokes it; see the "alleen Haiku" decision in
// .claude/rules/tembed-workflows.md.
func resolveCallWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ResolveCallInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if len(in.Calls) == 0 {
		return json.Marshal(map[string]int{"found": 0})
	}
	if err := w.ExecuteActivity("markCallsSearching", in, nil); err != nil {
		return nil, fmt.Errorf("mark searching: %w", err)
	}

	// Haiku only (context-only shortlist) — no Sonnet escalation.
	var haiku []callresolve.Entry
	if err := w.ExecuteActivity("resolveWithModel", resolveArg{
		PR: in.PR, CallerID: in.CallerID, CallerFile: in.CallerFile,
		CallerClass: in.CallerClass, CallerName: in.CallerName,
		Calls: in.Calls, Model: claude.ModelHaiku,
	}, &haiku); err != nil {
		return nil, fmt.Errorf("resolve haiku: %w", err)
	}

	byKey := map[string]callresolve.Entry{}
	for _, e := range haiku {
		byKey[e.CallKey] = e
	}

	// Persist the merged result in the deterministic order of in.Calls.
	final := make([]callresolve.Entry, 0, len(in.Calls))
	found := 0
	for _, c := range in.Calls {
		if e, ok := byKey[c]; ok {
			final = append(final, e)
			if e.Status == callresolve.StatusFound {
				found++
			}
		}
	}
	if err := w.ExecuteActivity("saveResolutions", final, nil); err != nil {
		return nil, fmt.Errorf("save resolutions: %w", err)
	}
	return json.Marshal(map[string]int{"found": found})
}

// StartResolveCall launches a resolve_call Execution and returns its Run ID.
// Starting an Execution is the sanctioned UI write path.
func (m *TaskManager) StartResolveCall(in ResolveCallInput) (string, error) {
	return m.engine.StartWorkflow(WorkflowResolveCall, in)
}

// explainCodeWorkflow generates the footer's AI description of a unit's
// if-statement. Deterministic: the LLM call is an Activity, the done/failed
// decision reads that Activity's recorded result (history), and the Activity
// order/count is fixed — mark searching, generate, save.
func explainCodeWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ExplainCodeInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("markExplainSearching", in, nil); err != nil {
		return nil, fmt.Errorf("mark searching: %w", err)
	}
	var gen struct {
		Text string `json:"text"`
	}
	if err := w.ExecuteActivity("generateExplanation", in, &gen); err != nil {
		return nil, fmt.Errorf("generate explanation: %w", err)
	}
	status := explanations.StatusDone
	model := "haiku"
	if gen.Text == "" {
		// Offline (claude.Fake) or a Claude hiccup: record a terminal "failed"
		// row so the frontend stops showing "genereren…" and never re-requests
		// this exact unit+code (the deterministic Run ID already dedups).
		status = explanations.StatusFailed
		model = ""
	}
	if err := w.ExecuteActivity("saveExplanation", explanations.Entry{
		PR: in.PR, BlockID: in.BlockID, UnitKey: in.UnitKey, CodeHash: in.CodeHash,
		Status: status, Text: gen.Text, Model: model,
	}, nil); err != nil {
		return nil, fmt.Errorf("save explanation: %w", err)
	}
	return json.Marshal(map[string]string{"status": status})
}

// StartExplainCode launches an explain_code Execution under its deterministic
// Run ID (explainRunID) — StartWorkflowID makes a repeated start for the same
// unit+code an idempotent no-op reuse, so the UI can fire on every qualifying
// selection without ever duplicating an LLM call. Starting an Execution is the
// sanctioned UI write path.
func (m *TaskManager) StartExplainCode(in ExplainCodeInput) (string, error) {
	return m.engine.StartWorkflowID(explainRunID(in), WorkflowExplainCode, in)
}

// resolveTestCoversWorkflow resolves a test's class-level-only coverage
// annotations (#[CoversClass]/bare "@covers Class") with the LLM — never for a
// test with no annotation at all (that never reaches this workflow). It is
// deterministic: the LLM/worktree work is in a single Activity, run once per
// class to completion. It uses ONLY Haiku (context-only) — no automatic Sonnet
// escalation. The generic Sonnet/agentic machinery in resolve_test_covers.go
// still exists but this workflow never invokes it; see the "alleen Haiku"
// decision in .claude/rules/tembed-workflows.md.
//
// Before asking Haiku, it checks whether a sibling test (same PR + same test
// file) already resolved the same covered class — see reuseSiblingCovers.
// That check is its own Activity (reuseTestCoverSiblings), so the number of
// subsequent resolveTestCoversWithModel calls (zero when every class was
// reused) is a pure function of that Activity's persisted result, replaying
// deterministically like callresolve's HadCandidates gate.
func resolveTestCoversWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ResolveTestCoversInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if len(in.Classes) == 0 {
		return json.Marshal(map[string]int{"found": 0})
	}
	if err := w.ExecuteActivity("markTestCoversSearching", in, nil); err != nil {
		return nil, fmt.Errorf("mark searching: %w", err)
	}

	var reuse testCoverReuseResult
	if err := w.ExecuteActivity("reuseTestCoverSiblings", testCoverReuseArg{
		PR: in.PR, TestID: in.TestID, TestFile: in.TestFile, Classes: in.Classes,
	}, &reuse); err != nil {
		return nil, fmt.Errorf("reuse siblings: %w", err)
	}

	// Haiku only (context-only shortlist) — no Sonnet escalation — and only
	// for the classes no sibling already resolved.
	var haiku []testcovers.Entry
	if len(reuse.Remaining) > 0 {
		if err := w.ExecuteActivity("resolveTestCoversWithModel", testCoverArg{
			PR: in.PR, TestID: in.TestID, TestFile: in.TestFile,
			TestClass: in.TestClass, TestName: in.TestName,
			Classes: reuse.Remaining, Model: claude.ModelHaiku,
		}, &haiku); err != nil {
			return nil, fmt.Errorf("resolve haiku: %w", err)
		}
	}

	byClass := map[string]testcovers.Entry{}
	for _, e := range reuse.Reused {
		byClass[e.CoveredClass] = e
	}
	for _, e := range haiku {
		byClass[e.CoveredClass] = e
	}

	// Persist the merged result in the deterministic order of in.Classes.
	final := make([]testcovers.Entry, 0, len(in.Classes))
	found := 0
	for _, c := range in.Classes {
		if e, ok := byClass[shortName(c)]; ok {
			final = append(final, e)
			if e.Status == testcovers.StatusFound {
				found++
			}
		}
	}
	if err := w.ExecuteActivity("saveTestCoverResolutions", final, nil); err != nil {
		return nil, fmt.Errorf("save resolutions: %w", err)
	}
	return json.Marshal(map[string]int{"found": found})
}

// StartResolveTestCovers launches a resolve_test_covers Execution and returns
// its Run ID. Starting an Execution is the sanctioned UI write path.
func (m *TaskManager) StartResolveTestCovers(in ResolveTestCoversInput) (string, error) {
	return m.engine.StartWorkflow(WorkflowResolveTestCovers, in)
}

// prStatusWorkflow is the per-PR lifecycle tracker. It is deterministic: it only
// consumes "state" Signals (fed by the pollers) and records them in its history.
// The Execution completes once the PR is no longer open (merged or closed) — that
// terminal state is the durable record the comment pollers read to stop.
func prStatusWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in PRStatusInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	// Fetch the PR's metadata in three stages, once at start (synchronously,
	// inside StartWorkflow), so the read-model fills in progressively before the
	// tracker parks on the first state Signal: basics (title/body/Jira) first,
	// then the Claude summary, then review/CI statuses. The UI polls GET /api/pr
	// and renders whatever stage has landed so far.
	if err := w.ExecuteActivity("fetchPRBasics", in, nil); err != nil {
		return nil, fmt.Errorf("fetch pr basics: %w", err)
	}
	if err := w.ExecuteActivity("generatePRSummary", in, nil); err != nil {
		return nil, fmt.Errorf("generate pr summary: %w", err)
	}
	if err := w.ExecuteActivity("fetchPRStatuses", in, nil); err != nil {
		return nil, fmt.Errorf("fetch pr statuses: %w", err)
	}
	for {
		var s PRStateSignal
		w.WaitSignal(SignalPRState, &s)
		if s.State == "merged" || s.State == "closed" {
			return json.Marshal(map[string]any{"pr": in.PR, "state": s.State})
		}
		// An ingest-refresh request (pollIngestRefresh observed a newer head
		// SHA than what was last ingested): refresh the delta, then re-derive
		// relations/callresolve from the PR's full current block list (cheap —
		// bounded by PR size, read from the DB, not a re-parse — and safe: a
		// full keep-set never prunes a still-valid unrelated row). Skip the
		// rebuild entirely when the refresh found nothing new, so a stray/
		// duplicate signal doesn't pay for a no-op relations rebuild.
		if s.HeadSHA != "" {
			var res ingestResult
			arg := struct {
				PR      int    `json:"pr"`
				BaseSHA string `json:"baseSHA"`
				HeadSHA string `json:"headSHA"`
			}{PR: in.PR, BaseSHA: s.BaseSHA, HeadSHA: s.HeadSHA}
			if err := w.ExecuteActivity("refreshIngestDelta", arg, &res); err != nil {
				return nil, fmt.Errorf("refresh ingest delta: %w", err)
			}
			if !res.Skipped {
				if err := w.ExecuteActivity("buildRelations", BuildRelationsInput{PR: in.PR}, nil); err != nil {
					return nil, fmt.Errorf("rebuild relations after refresh: %w", err)
				}
			}
		}
	}
}

// jiraKeyRe matches a KEY-123-style Jira ticket key inside a PR title. Mirrors
// the frontend's own extraction (src/home.mjs, src/overview.mjs) so the `/`
// menu's deep-link and this backend-derived key always agree.
var jiraKeyRe = regexp.MustCompile(`\b([A-Z][A-Z0-9]+-\d+)\b`)

// jiraKeyFromTitle extracts the first KEY-123-style ticket key from a PR title,
// or "" when there isn't one.
func jiraKeyFromTitle(title string) string {
	m := jiraKeyRe.FindStringSubmatch(title)
	if m == nil {
		return ""
	}
	return m[1]
}

// changedFilesFor returns the distinct changed files of pr (from the blocks
// table), for the PR-summary prompt. Best-effort: a nil db or query error just
// yields no files.
func changedFilesFor(db *sql.DB, pr int) ([]string, error) {
	if db == nil {
		return nil, nil
	}
	rows, err := db.Query(`SELECT DISTINCT file FROM blocks WHERE pr = ? ORDER BY file`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// prSummaryPrompt builds the call-specific Haiku prompt for the PR-summary
// stage: title, body, changed files, and (when linked) the Jira issue's title
// + description. The call-independent task framing ("Vat in 2-4 zinnen
// samen...") is static across every PR, so it travels separately as
// claude.PRSummarySystemPrompt (--append-system-prompt) — see the
// generatePRSummary Activity above and modules/claude/prompts.go.
func prSummaryPrompt(meta prmeta.Meta, files []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Titel: %s\n", meta.Title)
	if meta.Body != "" {
		fmt.Fprintf(&b, "Omschrijving:\n%s\n", meta.Body)
	}
	if len(files) > 0 {
		fmt.Fprintf(&b, "Gewijzigde bestanden:\n%s\n", strings.Join(files, "\n"))
	}
	if meta.JiraKey != "" {
		fmt.Fprintf(&b, "Jira-ticket %s: %s\n%s\n", meta.JiraKey, meta.JiraTitle, meta.JiraDesc)
	}
	return b.String()
}

// taskCodeCommentWorkflow is the durable definition. It is deterministic: all
// side effects go through Activities and Signals.
// commentPath builds the hierarchical address a comment hangs on, from the PR
// down to the exact code reference:
//
//	/pr-<pr>/<file>/<label>/<codeRef>/comment-<id>
//
// The file keeps its slashes, so it forms natural sub-segments (a directory
// prefix matches too). A prefix search then narrows by scope: "/pr-123" is the
// whole PR, "/pr-123/app/Foo.php" one file, ".../Foo::bar" one block, and
// ".../group-5-9" one navigation unit. Pure function of the input + Run ID, so
// it's deterministic under workflow replay.
func commentPath(in CodeCommentInput, id string) string {
	parts := []string{fmt.Sprintf("pr-%d", in.PR)}
	if in.File != "" {
		parts = append(parts, in.File) // already a validated repo-relative path
	}
	if in.Label != "" {
		parts = append(parts, pathSeg(in.Label))
	}
	if ref := codeRef(in); ref != "" {
		parts = append(parts, ref)
	}
	parts = append(parts, "comment-"+id)
	return "/" + strings.Join(parts, "/")
}

// codeRef names the navigation unit segment of a comment path: the granularity
// plus its row anchor (and, for a call, its segment key). Empty when the anchor
// is unknown and there's no granularity to fall back on.
func codeRef(in CodeCommentInput) string {
	if in.RowStart < 0 {
		return in.Gran // block-level / unknown rows: just the granularity (or "")
	}
	switch in.Gran {
	case "line":
		return fmt.Sprintf("line-%d", in.RowStart)
	case "call":
		if in.Seg != "" {
			return fmt.Sprintf("call-%d-%s", in.RowStart, pathSeg(in.Seg))
		}
		return fmt.Sprintf("call-%d", in.RowStart)
	default: // group (the default granularity)
		return fmt.Sprintf("group-%d-%d", in.RowStart, in.RowEnd)
	}
}

// pathSeg makes a single path segment safe: it keeps letters, digits and the
// harmless punctuation a symbol/segment key uses (`. _ - :`) and turns anything
// else (spaces, slashes, …) into `-`, so a segment can't inject an extra `/`.
func pathSeg(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-', r == ':':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

func taskCodeCommentWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in CodeCommentInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	runID := w.RunID()

	// Store the comment (comments module) and post it (github module). The
	// hierarchical Path is built here (deterministic from input + Run ID) so it
	// lands in the read-model via the workflow, not from the UI.
	comment := comments.Comment{
		ID: runID, RunID: runID, PR: in.PR, File: in.File, Line: in.Line,
		Author: in.Author, Body: in.Body, CreatedAt: in.CreatedAt,
		Code: in.Code, Gran: in.Gran, Label: in.Label,
		RowStart: in.RowStart, RowEnd: in.RowEnd, Seg: in.Seg,
		Path: commentPath(in, runID), Source: in.Source, Kind: in.Kind,
	}
	if err := w.ExecuteActivity("saveComment", comment, nil); err != nil {
		return nil, fmt.Errorf("save comment: %w", err)
	}
	// Decide the GitHub root comment ID this thread mirrors to, without ever
	// posting twice. Three input-driven (so replay-deterministic) cases:
	//   - Imported (ImportedRootID != 0): the comment already exists on GitHub —
	//     skip postGithubComment but record its known RootID, so the poller runs
	//     and UI replies still mirror to the real thread.
	//   - Local (private note): never touches GitHub — RootID stays 0, disabling
	//     the poller and every reply/delete mirror via the existing RootID == 0 guard.
	//   - Normal: post it and record the new RootID.
	var posted postResult
	switch {
	case in.ImportedRootID != 0:
		posted.RootID = in.ImportedRootID
	case !in.Local:
		if err := w.ExecuteActivity("postGithubComment", in, &posted); err != nil {
			return nil, fmt.Errorf("post github comment: %w", err)
		}
	}

	// Reactions loop: each "reply" Signal (UI or GitHub) is stored, mirrored to
	// the other side, and closes the thread when Done. A "delete" Action instead
	// removes the comment — first flipping its status to "deleting", then
	// deleting it on GitHub (best-effort) and from our own store — and completes
	// the execution, ending the thread.
	reactions := 0
	for {
		var r ReactionSignal
		w.WaitSignal(SignalReply, &r)

		if r.Action == "delete" {
			if err := w.ExecuteActivity("markCommentDeleting", map[string]any{"id": runID}, nil); err != nil {
				return nil, fmt.Errorf("mark comment deleting: %w", err)
			}
			if err := w.ExecuteActivity("deleteGithubComment", map[string]any{
				"pr": in.PR, "rootId": posted.RootID,
			}, nil); err != nil {
				return nil, fmt.Errorf("delete github comment: %w", err)
			}
			if err := w.ExecuteActivity("deleteComment", map[string]any{"id": runID}, nil); err != nil {
				return nil, fmt.Errorf("delete comment: %w", err)
			}
			return json.Marshal(map[string]any{"comment": runID, "deleted": true})
		}

		reactions++
		if err := w.ExecuteActivity("saveReaction", comments.Reaction{
			ID: r.ID, CommentID: runID, Source: r.Source, Author: r.Author, Body: r.Body, Resolves: r.Done,
		}, nil); err != nil {
			return nil, fmt.Errorf("save reaction: %w", err)
		}
		// Mirror a UI reaction onto GitHub (best-effort). GitHub-sourced
		// reactions are not echoed back. The mirror path depends on the thread:
		//   - PR-wide (issue/review-summary): a reply posts a NEW issue comment to
		//     the flat PR conversation (there is no reply thread on GitHub); a
		//     resolve (Done) is local-only — GitHub has no resolve for these, so
		//     it never touches GitHub.
		//   - Review-diff thread: a real reply body mirrors as a review reply; a
		//     resolve (Done) resolves the conversation on GitHub via the GraphQL
		//     mutation. The "/resolve" sentinel body (sent by a bare resolve, see
		//     sendReaction/resolveFocusedComment in RelatedPanel.mjs) is not posted
		//     as text — it only carries the intent to resolve.
		if r.Source == "ui" {
			if isPRWide(in.Kind) {
				if !r.Done {
					_ = w.ExecuteActivity("postGithubIssueComment", map[string]any{
						"pr": in.PR, "body": r.Body,
					}, nil)
				}
			} else {
				if body := strings.TrimSpace(r.Body); body != "" && body != "/resolve" {
					_ = w.ExecuteActivity("replyGithub", map[string]any{
						"pr": in.PR, "rootId": posted.RootID, "body": r.Body,
					}, nil)
				}
				if r.Done {
					_ = w.ExecuteActivity("resolveGithubThread", map[string]any{
						"pr": in.PR, "rootId": posted.RootID,
					}, nil)
				}
			}
		}
		if r.Done {
			break
		}
	}
	return json.Marshal(map[string]any{"comment": runID, "reactions": reactions})
}

// StartCodeComment posts the comment (synchronously, inside StartWorkflow) and
// launches the GitHub poller. Returns the Run ID (== the comment ID).
func (m *TaskManager) StartCodeComment(ctx context.Context, in CodeCommentInput) (string, error) {
	runID, err := m.engine.StartWorkflow(WorkflowTaskCodeComment, in)
	if err != nil {
		return "", err
	}
	prRunID, err := m.ensurePRStatus(in.PR)
	if err != nil {
		m.logf("task_code_comment: ensure pr_status pr=%d: %v", in.PR, err)
		prRunID = ""
	}
	rootID, err := m.rootID(runID)
	if err != nil {
		return runID, err
	}
	if rootID != 0 {
		go m.poll(ctx, runID, in.PR, rootID, prRunID)
	}
	return runID, nil
}

// Signal delivers a reaction Signal to a running Workflow Execution (the UI
// path: the only way the UI writes anything).
func (m *TaskManager) Signal(runID string, r ReactionSignal) error {
	return m.engine.SignalWorkflow(runID, SignalReply, r)
}

// Heartbeat records that the reviewer is actively viewing thread runID, so the
// poller keeps its fast cadence. It mutates no durable state — only in-memory
// poll timing — so it sits outside the workflow write-boundary.
func (m *TaskManager) Heartbeat(runID string) {
	m.mu.Lock()
	m.lastBeat[runID] = time.Now()
	m.mu.Unlock()
}

// EnsurePRStatus ensures a pr_status tracker exists for pr (starting one, whose
// start synchronously fetches the PR's metadata into the prmeta read-model) and
// returns its Run ID. The UI calls this on page load so the `/` menu's
// Jira/GitHub links have the PR title. Starting/reusing an Execution is the
// sanctioned UI write path.
func (m *TaskManager) EnsurePRStatus(pr int) (string, error) {
	return m.ensurePRStatus(pr)
}

// ensurePRStatus returns the Run ID of the pr_status tracker for pr, starting one
// if none is live yet (one tracker per PR, reused across restarts).
func (m *TaskManager) ensurePRStatus(pr int) (string, error) {
	m.mu.Lock()
	if id, ok := m.prRuns[pr]; ok {
		m.mu.Unlock()
		return id, nil
	}
	if id := m.findPRStatusLocked(pr); id != "" {
		m.prRuns[pr] = id
		m.mu.Unlock()
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowPRStatus, PRStatusInput{PR: pr})
	if err != nil {
		m.mu.Unlock()
		return "", err
	}
	m.prRuns[pr] = id
	m.mu.Unlock()

	// Start the ingest-refresh poller for this PR's tracker — only when a
	// server runtime is actually driving background pollers (SetRuntime), and
	// only right here, when the Execution is genuinely new (a restart's
	// already-existing tracker is instead picked up by
	// ResumePRStatusPolling).
	if m.runtimeReady {
		go m.pollIngestRefresh(m.baseCtx, id, pr)
		// Import existing GitHub comments as live threads, and keep polling for
		// new ones on the same heartbeat cadence (mirrors pollIngestRefresh).
		go m.pollImportComments(m.baseCtx, id, pr)
	}
	return id, nil
}

// findPRStatusLocked scans for a running/waiting pr_status tracker for pr. It
// reads only the engine (no TaskManager state), so it is safe to call while
// holding m.mu.
func (m *TaskManager) findPRStatusLocked(pr int) string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowPRStatus {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin PRStatusInput
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr {
			return r.ID
		}
	}
	return ""
}

// EnsureRelations makes sure a build_relations Execution exists for pr and has
// (re)built its relations. It starts one if none is live (the initial build runs
// synchronously inside StartWorkflow); otherwise it signals a rebuild. One
// Execution per PR, reused across restarts. Called after a successful ingest.
func (m *TaskManager) EnsureRelations(ctx context.Context, pr int) {
	m.mu.Lock()
	runID := m.relRuns[pr]
	if runID == "" {
		runID = m.findBuildRelationsLocked(pr)
	}
	m.mu.Unlock()

	if runID == "" {
		id, err := m.engine.StartWorkflow(WorkflowBuildRelations, BuildRelationsInput{PR: pr})
		if err != nil {
			m.logf("build_relations: start pr=%d: %v", pr, err)
			return
		}
		m.mu.Lock()
		m.relRuns[pr] = id
		m.mu.Unlock()
		return
	}
	m.mu.Lock()
	m.relRuns[pr] = runID
	m.mu.Unlock()
	if err := m.engine.SignalWorkflow(runID, SignalRebuild, json.RawMessage("{}")); err != nil {
		m.logf("build_relations: rebuild signal pr=%d: %v", pr, err)
	}
}

// findBuildRelationsLocked scans for a running/waiting build_relations Execution
// for pr. Reads only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findBuildRelationsLocked(pr int) string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowBuildRelations {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin BuildRelationsInput
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr {
			return r.ID
		}
	}
	return ""
}

// EnsureApprovals ensures an approve tracker exists for pr (starting one if none
// is live) and returns its Run ID. The UI calls this on page load so it has a
// Run ID to signal approvals to; the tracker is reused across restarts (its
// waiting Execution is re-driven by engine.Recover). Starting/reusing an
// Execution is the sanctioned UI write path.
func (m *TaskManager) EnsureApprovals(pr int) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.apprRuns[pr]; ok {
		return id, nil
	}
	if id := m.findApproveLocked(pr); id != "" {
		m.apprRuns[pr] = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowApprove, ApproveInput{PR: pr})
	if err != nil {
		return "", err
	}
	m.apprRuns[pr] = id
	return id, nil
}

// EnsureIgnore ensures the single ignore tracker for the repo exists (starting
// one if none is live) and returns its Run ID. The UI calls this on the overview
// load so it has a Run ID to signal ignores to; the tracker is reused across
// restarts (its waiting Execution is re-driven by engine.Recover). Starting/
// reusing an Execution is the sanctioned UI write path. Per-repo, mirrors
// EnsureInbox.
func (m *TaskManager) EnsureIgnore() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ignoreRun != "" {
		return m.ignoreRun, nil
	}
	if id := m.findIgnoreRunLocked(); id != "" {
		m.ignoreRun = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowIgnore, IgnoreInput{Repo: m.repo})
	if err != nil {
		return "", err
	}
	m.ignoreRun = id
	return id, nil
}

// findIgnoreRunLocked scans for a running/waiting ignore Execution for m.repo.
// It reads only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findIgnoreRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowIgnore {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin IgnoreInput
		if json.Unmarshal(in, &pin) == nil && pin.Repo == m.repo {
			return r.ID
		}
	}
	return ""
}

// findApproveLocked scans for a running/waiting approve tracker for pr. It reads
// only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findApproveLocked(pr int) string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowApprove {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin ApproveInput
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr {
			return r.ID
		}
	}
	return ""
}

// EnsureInbox starts (or reuses) the single pr_inbox Execution for the repo,
// fetches an initial snapshot synchronously (so the read-model is populated
// before the server serves), and launches its refresh poller. Idempotent across
// restarts: it reuses an existing running/waiting Execution.
func (m *TaskManager) EnsureInbox(ctx context.Context) {
	m.mu.Lock()
	runID := m.inboxRun
	if runID == "" {
		runID = m.findInboxRunLocked()
	}
	m.mu.Unlock()

	if runID == "" {
		id, err := m.engine.StartWorkflow(WorkflowPRInbox, PRInboxInput{Repo: m.repo})
		if err != nil {
			m.logf("pr_inbox: start: %v", err)
			return
		}
		runID = id
	}
	m.mu.Lock()
	m.inboxRun = runID
	m.mu.Unlock()

	// Initial refresh runs the fetch Activity synchronously, so /api/inbox has a
	// snapshot the moment the server comes up.
	if err := m.engine.SignalWorkflow(runID, SignalRefresh, json.RawMessage("{}")); err != nil {
		m.logf("pr_inbox: initial refresh: %v", err)
	}
	go m.pollInbox(ctx, runID)
}

// InboxRunID returns the pr_inbox Run ID so the UI can signal/heartbeat it.
func (m *TaskManager) InboxRunID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.inboxRun
}

// RefreshInbox delivers a "refresh" Signal (the UI's on-load re-check). It only
// starts a fetch Activity inside the workflow — the sole state writer.
func (m *TaskManager) RefreshInbox(runID string) error {
	return m.engine.SignalWorkflow(runID, SignalRefresh, json.RawMessage("{}"))
}

// findInboxRunLocked scans for a running/waiting pr_inbox Execution for m.repo.
func (m *TaskManager) findInboxRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowPRInbox {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin PRInboxInput
		if json.Unmarshal(in, &pin) == nil && pin.Repo == m.repo {
			return r.ID
		}
	}
	return ""
}

// pollInbox signals a "refresh" on the heartbeat-driven cadence: fast
// (m.interval) while the overview is actively viewed (a heartbeat arrived within
// heartbeatWindow), else slow (m.idle). It never stops on its own — the inbox is
// a long-lived tracker — only when the context is cancelled or the run failed.
func (m *TaskManager) pollInbox(ctx context.Context, runID string) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	var lastPoll time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		m.mu.Lock()
		beat := m.lastBeat[runID]
		m.mu.Unlock()
		active := !beat.IsZero() && time.Since(beat) < heartbeatWindow
		want := m.idle
		if active {
			want = m.interval
		}
		if !lastPoll.IsZero() && time.Since(lastPoll) < want {
			continue
		}
		lastPoll = time.Now()

		status, err := m.engine.Status(runID)
		if err != nil || status == tembed.StatusFailed || status == tembed.StatusCompleted {
			return
		}
		if err := m.engine.SignalWorkflow(runID, SignalRefresh, json.RawMessage("{}")); err != nil {
			m.logf("pr_inbox: refresh signal run=%s: %v", runID, err)
		}
	}
}

// pollIngestRefresh checks, on the heartbeat-driven cadence (fast while a
// heartbeat for prRunID arrived within heartbeatWindow, else slow — same gate
// as poll/pollInbox), whether the PR's live head SHA has moved past what was
// last ingested. If so it signals the pr_status tracker (SignalPRState, State
// "" so it's read as an ingest-refresh request rather than a lifecycle
// transition) to run refreshIngestDelta. It stops once the tracker itself is
// done (merged/closed) — mirrors poll's shutdown check.
func (m *TaskManager) pollIngestRefresh(ctx context.Context, prRunID string, pr int) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	var lastPoll time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		m.mu.Lock()
		beat := m.lastBeat[prRunID]
		m.mu.Unlock()
		active := !beat.IsZero() && time.Since(beat) < heartbeatWindow
		want := m.idle
		if active {
			want = m.interval
		}
		if !lastPoll.IsZero() && time.Since(lastPoll) < want {
			continue
		}
		lastPoll = time.Now()

		status, err := m.engine.Status(prRunID)
		if err != nil || status == tembed.StatusCompleted || status == tembed.StatusFailed {
			return
		}

		meta, err := fetchPRMeta(ctx, pr)
		if err != nil {
			m.logf("pr_status: ingest refresh check pr=%d: %v", pr, err)
			continue
		}
		_, head, ok, err := loadIngestSHAs(m.db, pr)
		if err != nil {
			m.logf("pr_status: load ingest state pr=%d: %v", pr, err)
			continue
		}
		if !ok || meta.HeadRefOid == head {
			continue // no prior ingest yet, or nothing new since
		}
		sig := PRStateSignal{BaseSHA: meta.BaseRefOid, HeadSHA: meta.HeadRefOid}
		if err := m.engine.SignalWorkflow(prRunID, SignalPRState, sig); err != nil {
			m.logf("pr_status: signal ingest refresh pr=%d: %v", pr, err)
		}
	}
}

// pollImportComments imports existing GitHub comments (review-diff threads and
// PR-wide issue/review comments) as live task_code_comment Executions, then keeps
// checking for new ones on the same heartbeat-driven cadence as pollIngestRefresh
// (fast while a heartbeat for prRunID arrived within heartbeatWindow, else slow).
// It stops once the pr_status tracker is done (merged/closed). Reading GitHub in
// glue mirrors poll/pollInbox; the only write is starting an Execution (the
// sanctioned path), made idempotent by the deterministic gh-<id> Run ID.
func (m *TaskManager) pollImportComments(ctx context.Context, prRunID string, pr int) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	// Run one import immediately (don't wait a whole tick to surface existing
	// comments on first load), then gate later ticks to the cadence.
	m.importPRComments(ctx, pr)
	lastPoll := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		m.mu.Lock()
		beat := m.lastBeat[prRunID]
		m.mu.Unlock()
		active := !beat.IsZero() && time.Since(beat) < heartbeatWindow
		want := m.idle
		if active {
			want = m.interval
		}
		if !lastPoll.IsZero() && time.Since(lastPoll) < want {
			continue
		}
		lastPoll = time.Now()

		status, err := m.engine.Status(prRunID)
		if err != nil || status == tembed.StatusCompleted || status == tembed.StatusFailed {
			return
		}
		m.importPRComments(ctx, pr)
	}
}

// importPRComments fetches pr's existing GitHub comments, maps each to a
// CodeCommentInput, and starts a task_code_comment Execution per comment with a
// deterministic gh-<id> Run ID — so a re-import (a re-poll, a restart) is a
// StartWorkflowID no-op rather than a duplicate. It then launches the per-thread
// reply poller for any thread not already being polled. The GitHub fetch is a
// read (like poll/pollInbox); the Execution start is the only write.
func (m *TaskManager) importPRComments(ctx context.Context, pr int) {
	var blocks []Block
	if m.db != nil {
		var err error
		if blocks, err = blocksByPR(m.db, pr); err != nil {
			m.logf("import comments: blocks pr=%d: %v", pr, err)
			// Continue anyway — general (PR-wide) comments don't need blocks, and a
			// review comment with no blocks just degrades to PR-wide.
		}
	}

	var inputs []CodeCommentInput
	if reviews, err := m.gh.FetchReviewComments(ctx, pr); err != nil {
		m.logf("import comments: fetch review comments pr=%d: %v", pr, err)
	} else {
		for _, rc := range reviews {
			inputs = append(inputs, mapReviewComment(m.dataDir, pr, blocks, rc))
		}
	}
	if general, err := m.gh.FetchGeneralComments(ctx, pr); err != nil {
		m.logf("import comments: fetch general comments pr=%d: %v", pr, err)
	} else {
		for _, gc := range general {
			inputs = append(inputs, mapGeneralComment(pr, gc))
		}
	}

	prRunID, err := m.ensurePRStatus(pr)
	if err != nil {
		prRunID = ""
	}
	// Skip any GitHub comment already represented by one of this PR's existing
	// threads — an app-created comment (its posted GitHub ID is in history) or an
	// app-posted PR-wide reply (also in history) — so importing never duplicates
	// the app's own comments. StartWorkflowID's gh-<id> key already dedups repeat
	// imports of the same comment; this additionally dedups against app-created
	// ones, whose Run ID is NOT gh-<id>.
	known := m.knownGithubIDs(pr)
	for _, in := range inputs {
		if known[in.ImportedRootID] {
			continue
		}
		// Never import a kilo-review bot summary (see isKiloReview) — skip
		// before starting any Execution, so it stays out of the read-model.
		if isKiloReview(in.Body) {
			continue
		}
		runID := importedRunID(in.ImportedRootID)
		if _, err := m.engine.StartWorkflowID(runID, WorkflowTaskCodeComment, in); err != nil {
			m.logf("import comments: start run=%s pr=%d: %v", runID, pr, err)
			continue
		}
		// Start the reply poller once per thread. Only imported review-diff
		// threads have a live GitHub thread to poll; a PR-wide (Kind != "")
		// comment has no reply thread on the reviews/issues endpoints we mirror,
		// so it needs no poller (its RootID guards the reply mirror anyway).
		if in.Kind != "" || in.ImportedRootID == 0 {
			continue
		}
		m.mu.Lock()
		already := m.importPolled[runID]
		if !already {
			m.importPolled[runID] = true
		}
		m.mu.Unlock()
		if !already {
			go m.poll(ctx, runID, pr, in.ImportedRootID, prRunID)
		}
	}
}

// knownGithubIDs returns the set of GitHub comment IDs already represented by
// one of pr's task_code_comment threads, so importPRComments never re-imports an
// app-created comment (or an app-posted PR-wide reply) as a duplicate. It reads,
// per thread: the imported root ID from the input, and every GitHub ID this
// thread posted (postGithubComment / postGithubIssueComment results in history —
// the app-created root and any PR-wide replies). All durable (history/input), so
// it survives a restart. O(runs) — the same scale as ResumePolling.
func (m *TaskManager) knownGithubIDs(pr int) map[int64]bool {
	known := map[int64]bool{}
	runs, err := m.engine.Runs()
	if err != nil {
		return known
	}
	for _, r := range runs {
		if r.Workflow != WorkflowTaskCodeComment {
			continue
		}
		raw, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var in CodeCommentInput
		if json.Unmarshal(raw, &in) != nil || in.PR != pr {
			continue
		}
		if in.ImportedRootID != 0 {
			known[in.ImportedRootID] = true
		}
		hist, err := m.engine.History(r.ID)
		if err != nil {
			continue
		}
		for _, ev := range hist {
			if ev.Type != tembed.EventActivityCompleted {
				continue
			}
			if ev.Name != "postGithubComment" && ev.Name != "postGithubIssueComment" {
				continue
			}
			var pr postResult
			if json.Unmarshal(ev.Payload, &pr) == nil && pr.RootID != 0 {
				known[pr.RootID] = true
			}
		}
	}
	return known
}

// poll delivers each new GitHub reply as a "reply" Signal. Its cadence follows
// the reviewer: fast (m.interval) while a heartbeat arrived within
// heartbeatWindow, else slow (m.idle). On the slow cadence it also checks whether
// the PR is merged/closed, records it on the pr_status tracker, and stops.
func (m *TaskManager) poll(ctx context.Context, runID string, pr int, rootID int64, prRunID string) {
	seen := map[int64]bool{}
	// Wake at the fast cadence and re-evaluate each time, so a heartbeat arriving
	// mid-idle switches to fast promptly instead of after a full idle sleep. The
	// actual GitHub calls are gated to the desired cadence via lastPoll.
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	var lastPoll time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		m.mu.Lock()
		beat := m.lastBeat[runID]
		m.mu.Unlock()
		active := !beat.IsZero() && time.Since(beat) < heartbeatWindow
		want := m.idle
		if active {
			want = m.interval
		}
		if !lastPoll.IsZero() && time.Since(lastPoll) < want {
			continue // not yet time for the current cadence
		}
		lastPoll = time.Now()

		status, err := m.engine.Status(runID)
		if err != nil || status == tembed.StatusCompleted || status == tembed.StatusFailed {
			return
		}
		// Stop once the PR is no longer open — another poller for the same PR may
		// already have recorded merged/closed on the tracker.
		if prRunID != "" {
			if s, err := m.engine.Status(prRunID); err == nil && (s == tembed.StatusCompleted || s == tembed.StatusFailed) {
				return
			}
		}

		replies, err := m.gh.FetchReplies(ctx, pr, rootID)
		if err != nil {
			m.logf("task_code_comment: fetch replies pr=%d root=%d: %v", pr, rootID, err)
			continue
		}
		for _, r := range replies {
			if seen[r.ID] {
				continue
			}
			seen[r.ID] = true
			sig := ReactionSignal{
				ID: fmt.Sprintf("gh-%d", r.ID), Source: "github",
				Author: r.Author, Body: r.Body, Done: r.Done,
			}
			if err := m.engine.SignalWorkflow(runID, SignalReply, sig); err != nil {
				m.logf("task_code_comment: signal run=%s: %v", runID, err)
			}
		}

		// Slow cadence only: check whether the PR merged/closed. Record it on the
		// pr_status tracker (best-effort) and stop polling this thread.
		if !active {
			state, err := m.gh.PRState(ctx, pr)
			if err != nil {
				m.logf("task_code_comment: pr state pr=%d: %v", pr, err)
			} else if state != "open" {
				if prRunID != "" {
					if err := m.engine.SignalWorkflow(prRunID, SignalPRState, PRStateSignal{State: state}); err != nil {
						m.logf("task_code_comment: signal pr_status pr=%d: %v", pr, err)
					}
				}
				m.logf("task_code_comment: pr #%d %s — stop polling run=%s", pr, state, runID)
				return
			}
		}
	}
}

// rootID reads the GitHub root comment ID recorded by postGithubComment.
func (m *TaskManager) rootID(runID string) (int64, error) {
	hist, err := m.engine.History(runID)
	if err != nil {
		return 0, err
	}
	for _, ev := range hist {
		if ev.Type == tembed.EventActivityCompleted && ev.Name == "postGithubComment" {
			var pr postResult
			if err := json.Unmarshal(ev.Payload, &pr); err != nil {
				return 0, err
			}
			return pr.RootID, nil
		}
	}
	return 0, nil
}
