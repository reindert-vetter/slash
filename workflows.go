package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/autoingestpref"
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
	"slash/modules/jiraissues"
	"slash/modules/jiranotify"
	"slash/modules/langpref"
	"slash/modules/plan"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/reviewerusage"
	"slash/modules/testcovers"
	"slash/modules/warndismiss"
	"slash/modules/warnreviewed"
)

// This file wires the first task as a durable tembed Workflow. Terminology
// follows Temporal: a Workflow Type (task_code_comment) started as a Workflow
// Execution (identified by a Run ID), which drives Activities and reacts to
// Signals. The Workflow is the only writer of state; it drives two modules —
// the comments module (its own read-model store) and the github module — as
// Activities. Reactions hook onto a comment as "reply" Signals, delivered from
// both the UI and a GitHub poller.

// dbLockRetryDelays is the automatic backoff ladder for an Activity that fails
// with a transient SQLite lock contention error (see isTransientDBLockError):
// the wait AFTER attempt i, so len(dbLockRetryDelays)+1 attempts in total
// (~17h15m of waiting). A var, not a const slice, purely so a test can shrink
// it — nothing else ever writes it. Same shape as chatRetryDelays
// (chat_workflow.go), including the reasoning: the wait happens through
// w.Sleep (a durable timer that survives a restart), never a wall-clock sleep
// inside the workflow body, and the index is the loop counter — so which
// delay is used follows from the recorded history alone
// (.claude/rules/workflow-determinism.md).
//
// Reviewer report: "save reaction: database is locked (5) (SQLITE_BUSY)"
// still permanently failed a task_code_comment run under a sustained write
// burst, even with the 5s busy_timeout pragma (modules/sqlitedsn). Rather than
// raise that timeout further (still just a race against however long the
// burst lasts), the run now waits out real quiet periods instead: 15 minutes,
// 1 hour, 4 hours, 12 hours. After the last attempt still fails, the run ends
// up StatusFailed exactly as before, surfacing in "Mislukte taken" where it
// stays manually retryable (RetryRun) — deliberately finite, not an infinite
// retry loop, so a genuinely stuck/broken write doesn't hide there forever.
var dbLockRetryDelays = []time.Duration{
	15 * time.Minute,
	1 * time.Hour,
	4 * time.Hour,
	12 * time.Hour,
}

// isTransientDBLockError reports whether err looks like SQLite lock
// contention (SQLITE_BUSY/SQLITE_LOCKED) rather than a genuine failure —
// the only kind executeActivityWithLockRetry retries. A plain substring match
// on the driver's own error text (modernc.org/sqlite renders it as e.g.
// "database is locked (5) (SQLITE_BUSY)"), since neither database/sql nor the
// activity's wrapping introduces a typed error to match on instead.
func isTransientDBLockError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "SQLITE_BUSY") || strings.Contains(msg, "database is locked") ||
		strings.Contains(msg, "SQLITE_LOCKED")
}

// executeActivityWithLockRetry runs w.ExecuteActivity(name, input, result),
// and on a transient SQLite lock error (isTransientDBLockError) waits
// dbLockRetryDelays[attempt] on a durable timer and tries again, up to
// len(dbLockRetryDelays)+1 attempts total. Any other error — or the final,
// exhausted attempt — is returned unchanged, so an existing caller's own
// wrapping (fmt.Errorf("save reaction: %w", err)) still applies. Deterministic
// for the same reason as runChatTurnWithRetries: the loop bound and delay
// index follow only from the recorded Activity results and the loop counter.
func executeActivityWithLockRetry(w *tembed.Workflow, name string, input, result any) error {
	for attempt := 0; ; attempt++ {
		err := w.ExecuteActivity(name, input, result)
		if err == nil {
			return nil
		}
		if attempt >= len(dbLockRetryDelays) || !isTransientDBLockError(err) {
			return err
		}
		w.Sleep(dbLockRetryDelays[attempt])
	}
}

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
	// WorkflowJiraInbox is the Workflow Type that owns the reviewer's Jira
	// notification feed (the bell menu): ONE Execution for the whole process,
	// since that feed is per-user rather than per-repo. Each "jira_notify"
	// Signal either refreshes the feed into the jiranotify read-model or marks
	// one notification read. See jira_notifications.go.
	WorkflowJiraInbox = "jira_inbox"
	// WorkflowJiraIssues is the Workflow Type that owns the reviewer's own Jira
	// issues behind /pr-overview's "Planning" and "Todo" sections: ONE
	// Execution for the whole process, since those issues are assigned to the
	// reviewer and thus per-user rather than per-repo. Each "jira_issues"
	// Signal refreshes both lists into the jiraissues read-model, which the
	// HTTP handler only reads. See jira_issues.go.
	WorkflowJiraIssues = "jira_issues"
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
	// WorkflowRemoveReviewer is the Workflow Type that drops the local
	// reviewer (me) from a PR's requested reviewers: one Execution per "Verwijder
	// mij als reviewer" click in the /pr-overview row popover. It runs its one
	// Activity synchronously and completes — no signal, mirrors
	// WorkflowReadyForReview. WHO is removed is resolved server-side (the
	// authenticated GitHub user), never taken from the request, so this can
	// only ever remove yourself.
	WorkflowRemoveReviewer = "remove_reviewer"
	// WorkflowCodeWarning is the Workflow Type that agentically reviews a PR's
	// changed files for risks (correctness/security/style, and consistency
	// with the connected code the changes touch — callers, callees, tests,
	// listeners) using Sonnet with Read/Grep/Glob in the head worktree. One
	// Execution per manual "Controleer de hele PR op risico's" run (see the
	// "/" PR_COMMANDS menu); it re-checks the whole PR each time and
	// supersedes (deletes, via the existing delete Signal) the AI warnings of
	// every file in scope before creating fresh ones. No signal — it runs its
	// Activities sequentially and completes. See
	// .claude/docs/tembed-workflows.md ("AI-risicocontrole").
	WorkflowCodeWarning = "code_warning"
	// WorkflowIgnoreComment is the Workflow Type that persists which PR-wide
	// comments the reviewer chose to ignore (hide from the block index): one
	// Execution per PR, mirroring WorkflowApprove. Each "ignore" Signal carries
	// one comment id + the desired flag, which one Activity writes into the
	// commentignore read-model. It never completes — a long-lived per-PR
	// tracker. Per PR rather than per repo (unlike a repo-wide tracker) so the cleanup
	// workflow's Purge(ctx, pr) sweep picks these rows up for free; see the
	// package doc of modules/commentignore.
	WorkflowIgnoreComment = "ignore_comment"
	// WorkflowCleanup is the Workflow Type that purges all data of PRs merged
	// more than cleanupMergedAge ago: worktrees, workflow runs, and every
	// read-model row keyed on that PR. One Execution per run; it runs its two
	// Activities (resolveCleanupTargets, then purgePR once per resolved
	// target) sequentially and completes — no signal, mirrors WorkflowIngest/
	// WorkflowSubmitReview. Triggered manually (POST /api/workflows/cleanup)
	// and automatically once a day (see TaskManager.StartCleanupScheduler).
	WorkflowCleanup = "cleanup"
	// WorkflowClaudeChat is the Workflow Type behind the embedded Claude
	// conversation panel: one Execution per conversation, hanging off exactly
	// one existing comment thread (its Run ID is derived from that comment's
	// id, see chatConversationRunID in chat_workflow.go). Each "message" Signal
	// (a reviewer turn) drives one runClaudeTurn Activity and stores both
	// turns; it never completes — a long-lived per-conversation tracker, mould
	// of WorkflowTaskCodeComment's reactions loop. See
	// .claude/docs/tembed-workflows.md.
	WorkflowClaudeChat = "claude_chat"
	// WorkflowAutoWarn is the Workflow Type that persists the reviewer's on/off
	// preference for the AUTOMATIC code_warning trigger (see autoStartCodeWarning):
	// one Execution per repo, the same per-repo-tracker mould as WorkflowPRInbox. Each "autowarn" Signal
	// carries the desired enabled flag, which one Activity writes into the
	// autowarn read-model. It never completes — a long-lived per-repo tracker.
	// A manual "Diepgravend onderzoek" from the "/" menu never checks this flag —
	// only the automatic trigger does. See the "AI risk check" section of
	// .claude/docs/workflows-analysis.md.
	WorkflowAutoWarn = "auto_warn"
	// WorkflowAutoIngestPref is the Workflow Type that persists the reviewer's
	// repo-wide preference for AUTOMATIC review-tree generation (see
	// TaskManager.autoIngestOwnPRs): one Execution per repo, the same
	// per-repo-tracker mould as WorkflowAutoWarn. Each "auto_ingest_pref" Signal
	// carries the desired mode ("off"|"own"|"all"), which one Activity writes
	// into the autoingestpref read-model. It never completes — a long-lived
	// per-repo tracker. Clicking "Generate review tree" by hand is NEVER gated
	// by this — only the automatic trigger inside refreshInbox checks it. See
	// the "pr_inbox" section of .claude/docs/workflows-trackers.md.
	WorkflowAutoIngestPref = "auto_ingest_pref"
	// WorkflowLangPref is the Workflow Type that persists the reviewer's
	// repo-wide LANGUAGE preference per output type (see modules/langpref):
	// one Execution per repo, the same per-repo-tracker mould as
	// WorkflowAutoIngestPref. Each "lang_pref" Signal carries one
	// {kind, lang} pair ("ui"|"explain"|"reply" x "nl"|"en"), which one
	// Activity writes into the langpref read-model. It never completes — a
	// long-lived per-repo tracker. See .claude/docs/settings-page.md.
	WorkflowLangPref = "lang_pref"
	// WorkflowAppSettings is the Workflow Type that persists the two
	// reviewer-editable pieces of the local settings.json/praise-words.json
	// files that used to be read-only (settings.go, praisewords.go): the extra
	// @mention alias spellings under "me", and the praise-word list — both
	// surfaced on the settings page (.claude/docs/settings-page.md). ONE
	// Execution total, never repo/PR scoped: there is exactly one data dir per
	// running process, unlike every other tracker above. Each
	// "app_settings_update" Signal carries a Kind discriminator (a workflow can
	// only WaitSignal on one name at a time, see PRStateSignal/
	// ReactionSignal.Action) selecting which file's Activity runs. It never
	// completes — a long-lived, single, global tracker.
	WorkflowAppSettings = "app_settings"
	// WorkflowDebugLog is the Workflow Type that appends one batch of recorded
	// navigation/action events to <dataDir>/debug-log.jsonl, or clears that
	// file — the durable half of "Debug mode" (see debug_log.go and
	// .claude/docs/debug-mode.md). ONE-SHOT: one Execution per flushed batch,
	// signal-less, completing after its single Activity. Deliberately NOT a
	// long-lived tracker like app_settings above: tembed replays a workflow
	// from the beginning at every step, so a WaitSignal loop would replay
	// every earlier batch on every new one (quadratic, and inline under the
	// run lock). The completed runs carry nothing worth keeping — the file
	// does — so the cleanup workflow sweeps them (sweepDebugLogRuns).
	WorkflowDebugLog = "debug_log"
	// WorkflowIgnoreRuns is the Workflow Type behind "negeren" in the global
	// failed-tasks popup: the reviewer decided a failure needs no action, so
	// its run is permanently deleted from the tembed store and thereby from
	// every list built on it (the popup, the /pr-overview drawer, the review
	// tree's Taken block). ONE-SHOT: one Execution per "negeer" press,
	// signal-less, with exactly one deleteIgnoredRun Activity per named run
	// id, mirroring debugLogWorkflow above.
	//
	// Deleting rather than remembering an "ignored" flag is deliberate: there
	// is nothing left to ask about an ignored failure (a retry would have to
	// un-ignore it first), so a new module/read-model would only add a table
	// nothing ever reads back. engine.DeleteRun is the same durable primitive
	// the cleanup workflow already uses for a run nobody will act on again.
	WorkflowIgnoreRuns = "ignore_runs"
	// WorkflowCommentBatch is the Workflow Type behind "laat Claude alle
	// openstaande comments verwerken": ONE agentic Opus run that walks every
	// open comment of a PR and edits code for it, landing the result through the
	// existing chat_merge queue. One-shot, signal-less, and it deliberately never
	// replies to or resolves a comment — see comment_batch.go and
	// .claude/docs/workflows-comments.md.
	WorkflowCommentBatch = "comment_batch"
	// WorkflowTestRun is the Workflow Type behind "Tests laten draaien"
	// (PR_COMMANDS, src/home.mjs): ONE agentic run that itself decides which
	// EXISTING tests are relevant to a PR's changes and runs only those — no
	// Edit tool, no landing step, no fixed per-repo test command. One-shot,
	// signal-less. See test_run.go.
	WorkflowTestRun = "test_run"
	// WorkflowSummarizeChat is the Workflow Type that generates a short Dutch
	// summary (at most 2 sentences) of an embedded Claude conversation — the
	// prefill for "Comment hiervan maken" on a still-CLAUDE_ANCHOR_PLACEHOLDER
	// anchor comment (RelatedPanel.mjs). One Execution per conversation+message
	// count, started idempotently via a deterministic Run ID (see
	// chatSummaryRunID) so re-requesting with no new messages never triggers a
	// second LLM call; it completes when done (no signals). Haiku,
	// context-only — no escalation, mirroring explain_code/pr_status's summary.
	WorkflowSummarizeChat = "summarize_chat"
	// WorkflowCommentTitles is the Workflow Type that gives a BATCH of review
	// comments a short Dutch title (at most 6 words each) — the heading a long,
	// multi sentence comment shows above its clamped body, so a comment column
	// stays scannable. One Execution per (PR, set of untitled comments),
	// started idempotently via a deterministic Run ID (see commentTitlesRunID)
	// so the frontend may fire it on every comment poll without ever
	// triggering a second LLM call for the same set; it completes when done (no
	// signals). Haiku, context-only, one call for the whole batch — see
	// comment_titles.go and .claude/docs/workflows-analysis.md.
	WorkflowCommentTitles = "comment_titles"
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
	// SignalDelete is the URL-level signal name the UI posts to delete a
	// comment. It is delivered to the workflow as a ReactionSignal (Action:
	// "delete") under SignalReply — see ReactionSignal's doc comment.
	SignalDelete = "delete"
	// SignalIgnore delivers one comment's ignored state to the ignore_comment
	// tracker (from the UI, on the "Ignore"/"Ignore ongedaan maken" action).
	SignalIgnore = "ignore"
	// SignalAutoWarn delivers the desired on/off flag to the auto_warn tracker
	// (from the UI toggle next to the theme button). Deliberately a distinct
	// literal from SignalSet/SignalIgnore: the generic
	// .../signals/{name} route (tasks_api.go) dispatches purely on this literal,
	// so it must not collide with an existing one.
	SignalAutoWarn = "autowarn"
	// SignalJiraNotify carries every action of the jira_inbox tracker — a
	// refresh (the poller/the UI on load), a "the reviewer opened this one"
	// mark-read, its "mark unread again" mirror, and the mark-all-read bulk
	// action — distinguished by the payload's `kind`. One name, because
	// tembed's WaitSignal takes exactly one. Deliberately a distinct literal
	// from every other Signal name (the generic .../signals/{name} route
	// dispatches purely on it).
	SignalJiraNotify = "jira_notify"
	// SignalJiraIssues asks the jira_issues tracker to refresh both issue
	// lists (the 5-minute poller, and ?refresh=1 in the background).
	// Deliberately a distinct literal from every other Signal name (the
	// generic .../signals/{name} route dispatches purely on it).
	SignalJiraIssues = "jira_issues"
	// SignalAutoIngestPref delivers the desired mode ("off"|"own"|"all") to the
	// auto_ingest_pref tracker (from the UI toggle on /settings and in the
	// /pr-overview header). Deliberately a distinct literal from the other
	// Signal names — the generic .../signals/{name} route (tasks_api.go)
	// dispatches purely on this literal.
	SignalAutoIngestPref = "auto_ingest_pref"
	// SignalLangPref delivers one {kind, lang} language choice to the
	// lang_pref tracker (from the three toggles on /settings). One Signal name
	// with a Kind discriminator, exactly like SignalAppSettings: a workflow can
	// only WaitSignal on one name at a time.
	SignalLangPref = "lang_pref"
	// SignalAppSettings delivers one settings-page edit to the app_settings
	// tracker — its Kind field says which of the two writable fields (mention
	// aliases / praise words) the payload is for.
	SignalAppSettings = "app_settings_update"
	// SignalMessage delivers one reviewer turn to the claude_chat workflow.
	SignalMessage = "message"

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
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo   string `json:"repo,omitempty"`
	PR     int    `json:"pr"`
	File   string `json:"file"`
	Line   int    `json:"line"`
	Author string `json:"author"`
	// AvatarURL is the author's GitHub profile picture, set when this comment is
	// imported from GitHub (see mapReviewComment). Stored on the comment so the
	// thread shows the real picture instead of an initials circle; empty for a
	// comment placed in this app.
	AvatarURL string `json:"avatarUrl"`
	Body      string `json:"body"`
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
	// BlockWide mirrors comments.Comment.BlockWide — see its own doc comment.
	// Set by anchoredWarning (code_warning.go) for a finding that pins to a
	// block but not to a specific row.
	BlockWide bool `json:"blockWide"`
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

// resolveSentinel / reopenSentinel are the two command-like reply bodies that
// mark a thread's state change instead of carrying real text: a resolve
// (Done, sent by the UI's resolve commands) and an unresolve (Action
// "unresolve"). Both are stored as an ordinary reaction so the conversation
// shows WHEN and BY WHOM it happened, and neither is ever posted to GitHub as
// text — the frontend renders them as a status line rather than as a literal
// command (threadStatusSentinel, RelatedPanel.mjs).
//
// resolveSentinel's exact value is load-bearing in two directions: the mirror
// path below skips a reply with this body, and modules/github detects a
// GitHub-side resolve by looking for it in a reply body. reopenSentinel is
// deliberately NOT "/unresolve" for exactly that reason — that string CONTAINS
// "/resolve", so such a body coming back from GitHub would be read as a
// resolve.
const (
	resolveSentinel = "/resolve"
	reopenSentinel  = "/reopen"
)

// ReactionSignal is the payload of a "reply" Signal. It carries either a
// reaction hooking onto the comment (Action "" / "reply", from the UI or from
// GitHub) or a request to delete the comment (Action "delete") — both ride the
// same Signal because a workflow can only WaitSignal on one name at a time
// (see taskCodeCommentWorkflow's reactions loop), so a delete request has to
// be delivered as a distinguishable reply rather than a signal of its own.
type ReactionSignal struct {
	// ID is the new reply's own id (Action "" / "reply"), OR — with Action
	// "edit" — the id of the EXISTING message being edited: the thread's own
	// run ID for its root comment, or an existing reply's own reaction id.
	// Reused rather than adding a second field, the same way AvatarURL/Anchor
	// already change meaning per Action.
	ID     string `json:"id"`
	Source string `json:"source"` // ui | github | ai (an automated reply, e.g. comment_autoresolve.go)
	Author string `json:"author"`
	// AvatarURL is the reply author's GitHub profile picture, filled by the reply
	// poller for a github-sourced reply; empty for a UI reply. With Action
	// "avatar" it instead carries the ROOT comment's own avatar (a backfill, no
	// reply is stored).
	AvatarURL string `json:"avatarUrl"`
	// Body is the reply text (Action "" / "reply"), or the new wording (Action
	// "edit").
	Body string `json:"body"`
	Done bool   `json:"done"` // resolves the thread (Body is then resolveSentinel)
	// Action "publish" carries no message at all: it publishes the thread AS IT
	// STANDS (the root, plus the earlier local replies with PublishHistory) —
	// the reviewer moving an existing local conversation to GitHub without
	// typing a new reply first. Stores no reaction.
	Action string `json:"action"` // "" (reply, default) | "delete" | "avatar" | "reanchor" | "chat" | "edit" | "publish" | "unresolve"
	// Publish promotes a thread that has never touched GitHub (a private note,
	// or an "ai" code_warning finding — both start with posted.RootID == 0) to a
	// real GitHub thread, as part of delivering THIS reply. Empty (the default)
	// keeps the thread local, exactly as before:
	//   - "reply"  — only the reviewer's own reply reaches GitHub. There is no
	//     root to reply to, so this reply itself BECOMES the GitHub root
	//     comment; the local root's body (e.g. the AI finding) stays private.
	//   - "thread" — the local root's body is posted first (an "ai" root as an
	//     attributed quote, see aiQuoteBody), and this reply then mirrors onto
	//     it through the ordinary reply path.
	// Ignored once the thread already has a GitHub root (posted.RootID != 0):
	// from that point every reply mirrors anyway, which is exactly the
	// "once it's a GitHub chat, it stays one" rule.
	Publish string `json:"publish,omitempty"`
	// PublishHistory additionally mirrors the reviewer's OWN earlier replies —
	// the ones written while the thread was still local — in their original
	// order, right after the root lands. Only meaningful together with Publish
	// (or Action "publish"). AI/system notes in the thread are never mirrored.
	PublishHistory bool `json:"publishHistory,omitempty"`
	// Anchor carries the comment's re-derived row anchor with Action "reanchor" (a
	// pure metadata move, no reply stored) — see reanchor.go for how it's computed
	// and comments.Module.SetAnchor for what it changes.
	Anchor *commentAnchorUpdate `json:"anchor,omitempty"`
}

// postResult carries the GitHub root comment ID (0 when GitHub is unavailable).
type postResult struct {
	RootID int64 `json:"rootId"`
}

// PRStatusInput starts a pr_status Workflow Execution — one tracker per PR.
type PRStatusInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
}

// PRStateSignal drives the pr_status tracker via SignalPRState. It carries
// either an observed PR lifecycle state ("merged"/"closed", State != "") from
// the comment/inbox pollers, an ingest-refresh request (State == "" &&
// HeadSHA != "") from pollIngestRefresh, when it observes a head SHA newer
// than what was last ingested, or a "re-derive what changed since my own last
// review" request (RefreshSince) from the review tree at page load. All ride
// the same signal name because a workflow can only WaitSignal on one name at a
// time (mirrors ReactionSignal.Action / ApprovalSignal.Viewed).
type PRStateSignal struct {
	State   string `json:"state,omitempty"`
	BaseSHA string `json:"baseSHA,omitempty"` // ingest-refresh: newly observed base SHA
	HeadSHA string `json:"headSHA,omitempty"` // ingest-refresh: newly observed head SHA
	// RefreshSince re-runs stages 3+4 (fetchPRStatuses +
	// generateSinceReviewSummary). Those two only ever ran ONCE, at Execution
	// start, while the tracker is reused for the PR's whole lifetime — so the
	// review tree's "Sinds jouw laatste review" block was a snapshot of
	// whenever the tracker happened to start and stayed empty/stale forever
	// after, even though the PR overview's own "nieuw sinds jouw review" line
	// (computed live per poll, inbox.go) already said there was something new.
	RefreshSince bool `json:"refreshSince,omitempty"`
	// LandedFiles are the repo-relative paths a reviewer's own chat edit just
	// landed on the PR's branch, threaded through from refreshTreeAfterLanding
	// (chat_merge.go) so the refreshIngestDelta Activity below can embed them
	// directly in the blocks.changed event it publishes — see
	// chat_refresh_pending.go and .claude/docs/pending-push.md ("Wordt
	// bijgewerkt"). Empty for the ordinary colleague-push poller
	// (pollIngestRefresh), which never knows which files a landing touched.
	// Purely a UI-routing hint carried alongside already-recorded Signal
	// input — never re-derived live inside the workflow body, so this stays
	// replay-safe exactly like BaseSHA/HeadSHA above.
	LandedFiles []string `json:"landedFiles,omitempty"`
}

// PRInboxInput starts the pr_inbox Workflow Execution for a repo.
type PRInboxInput struct {
	Repo string `json:"repo"`
}

// BuildRelationsInput starts (and re-signals) a build_relations Execution — one
// per PR.
type BuildRelationsInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
}

// ApproveInput starts an approve Execution — one tracker per PR.
type ApproveInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
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
	// Anchors is the code each approved row pointed at, sent along by the UI
	// (persistApproval, home.mjs) so the row can be found again after the PR
	// gets new commits — see reanchor.go. An older client, or a caller that
	// only trims an existing set, may leave it empty; the row indices then
	// still apply, they just can't be re-anchored from text.
	Anchors []approvals.RowAnchor `json:"anchors"`
	File    string                `json:"file"`
	Viewed  *bool                 `json:"viewed"`
	// FullyApproved rides the same "set" Signal a third way (mirrors the
	// File/Viewed pair above): true means the client just detected the
	// transition into "every changed row/call in the tree is now approved"
	// (state.approvalTotal, home.mjs) and asks to stamp prmeta's
	// FullyApprovedAt with the current time — see combineSinceMoment
	// (inbox.go) for what that feeds into. BlockID/Rows/Calls/File/Viewed are
	// ignored when this is true.
	FullyApproved bool `json:"fullyApproved,omitempty"`
}

// AutoWarnInput starts an auto_warn Execution — one tracker per repo.
type AutoWarnInput struct {
	Repo string `json:"repo"`
}

// AutoWarnSignal carries the desired on/off flag into the auto_warn tracker
// (delivered under SignalAutoWarn).
type AutoWarnSignal struct {
	Enabled bool `json:"enabled"`
}

// AutoIngestPrefInput starts an auto_ingest_pref Execution — one tracker per
// repo.
type AutoIngestPrefInput struct {
	Repo string `json:"repo"`
}

// AutoIngestPrefSignal carries the desired mode into the auto_ingest_pref
// tracker (delivered under SignalAutoIngestPref).
type AutoIngestPrefSignal struct {
	Mode string `json:"mode"` // "off" | "own" | "all"
}

// LangPrefInput starts a lang_pref Execution — one tracker per repo.
type LangPrefInput struct {
	Repo string `json:"repo"`
}

// LangPrefSignal carries one language choice into the lang_pref tracker
// (delivered under SignalLangPref). Kind is the output type
// ("ui"|"explain"|"reply"), Lang the language ("nl"|"en").
type LangPrefSignal struct {
	Kind string `json:"kind"`
	Lang string `json:"lang"`
}

// AppSettingsInput starts the single, global app_settings Execution. No
// fields: unlike every other tracker above there is only ever one data dir per
// process, so there is nothing to scope by.
type AppSettingsInput struct{}

// AppSettingsSignal carries one settings-page edit into the app_settings
// tracker (delivered under SignalAppSettings). Kind selects which field —
// "aliases" or "praiseWords" — the same one-Signal-many-Kinds shape as
// ReactionSignal.Action/PRStateSignal, because a workflow can only WaitSignal
// on one name at a time.
type AppSettingsSignal struct {
	Kind        string   `json:"kind"` // "aliases" | "praiseWords" | "notifyFilters" | "jiraCreds"
	Aliases     []string `json:"aliases,omitempty"`
	PraiseWords []string `json:"praiseWords,omitempty"`
	// NotifyFilters carries the Jira-notification noise filter of the settings
	// page (Kind "notifyFilters") — the texts whose notifications the bell on
	// /pr-overview hides. An EMPTY list is a real value here ("show me
	// everything again"), unlike PraiseWords; see notifyfilters.go.
	NotifyFilters []string `json:"notifyFilters,omitempty"`
	// JiraCreds carries the Atlassian notification-feed credentials of the
	// settings page's auth row (Kind "jiraCreds"). They land in the gitignored
	// .env, NOT in settings.json — that file is served verbatim to the browser
	// by GET /api/settings, so a token in it would leak to every page. See
	// auth_status.go.
	JiraCreds *JiraCredsSignal `json:"jiraCreds,omitempty"`
}

// JiraCredsSignal is one settings-page edit of the Jira API-token trio. An
// EMPTY Token deliberately means "keep whatever is stored": the settings page
// never receives the current token back (only a masked tail), so it cannot
// send it back either, and a reviewer correcting just the e-mail address must
// not wipe the token by doing so.
type JiraCredsSignal struct {
	Email string `json:"email"`
	Site  string `json:"site"`
	Token string `json:"token"`
}

// IgnoreCommentInput starts an ignore_comment Execution — one tracker per PR.
type IgnoreCommentInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
}

// IgnoreCommentSignal carries one comment's ignored state into the
// ignore_comment tracker (delivered under SignalIgnore). Ignored = false
// un-ignores it again. Deliberately a plain flag with no expiry: "ignored"
// belongs with "resolved"/"approved" (reviewer decisions that never lapse),
// not with SnoozeSignal's temporary Until.
type IgnoreCommentSignal struct {
	CommentID string `json:"commentId"`
	Ignored   bool   `json:"ignored"`
}

// IgnoreRunsInput starts an ignore_runs Execution: the failed runs the
// reviewer chose to ignore. One Activity per id, in the given order, so the
// number of Activities is a pure function of the input (replay-safe).
type IgnoreRunsInput struct {
	RunIDs []string `json:"runIds"`
}

// IgnoreRunsResult reports what the Execution did: Ignored counts the runs
// really deleted, Skipped the ones that were not eligible (an unknown id, or a
// run that is not `failed` — see the deleteIgnoredRun Activity).
type IgnoreRunsResult struct {
	Ignored int `json:"ignored"`
	Skipped int `json:"skipped"`
}

// ResolveCallInput starts a resolve_call Execution: it asks the LLM to resolve
// the given (Go-unresolved) call keys made by one caller block.
type ResolveCallInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo        string   `json:"repo,omitempty"`
	PR          int      `json:"pr"`
	CallerID    string   `json:"callerId"`
	CallerFile  string   `json:"callerFile"`
	CallerClass string   `json:"callerClass"`
	CallerName  string   `json:"callerName"`
	Calls       []string `json:"calls"`
	// Attempt is the search GENERATION of this input: 0 for the first pass over
	// these calls, 1 for the one extra retry round a call may ever get (see
	// maxResolveCallAttempts / groupUnresolvedCalls). It exists purely to give
	// the retry its own identity: resolveCallRunID folds it into the Run ID, so
	// re-asking a call the history already knows about is a genuinely different
	// (but still deterministic and idempotent) Execution instead of the no-op
	// reuse the plain caller+calls hash would produce. Kept `omitempty` so a
	// generation-0 input hashes byte-identically to every Run ID minted before
	// this field existed — an already-answered call must not silently re-run.
	Attempt int `json:"attempt,omitempty"`
}

// ResolveTestCoversInput starts a resolve_test_covers Execution: it asks the
// LLM which method of each named class the given test covers — only for
// classes a class-level-only annotation named (the Go analyzer's "unresolved"
// status).
type ResolveTestCoversInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo      string   `json:"repo,omitempty"`
	PR        int      `json:"pr"`
	TestID    string   `json:"testId"`
	TestFile  string   `json:"testFile"`
	TestClass string   `json:"testClass"`
	TestName  string   `json:"testName"`
	Classes   []string `json:"classes"`
}

// ExplainCodeInput starts an explain_code Execution: it asks Haiku to describe
// (in Dutch, 1-2 sentences) one selected navigation unit — any group/line
// unit the reviewer lands on while navigating a diff, not only one containing
// an if-statement (the frontend's earlier if-only gate was lifted, see
// footerUnitInfo in home.mjs). Everything the LLM sees travels in the input —
// the unit's code plus the surrounding block source — so the workflow body
// stays a pure function of its input (no worktree reads). UnitKey addresses
// the unit within the block in aligned-row space (`group-<start>-<end>` /
// `line-<row>`, the same codeRef shape as commentPath); CodeHash fingerprints
// Code+Context so a stale row is ignored by the frontend after the code
// changes.
type ExplainCodeInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo     string `json:"repo,omitempty"`
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

// SummarizeChatInput starts a summarize_chat Execution: it asks Haiku
// (context-only, no tools) for a short Dutch summary of one embedded Claude
// conversation, keyed by the conversation's own comment id. The workflow
// itself reads the conversation's transcript via an Activity (chat.Module.List)
// rather than carrying it in the input — unlike explain_code's unit code, a
// conversation can grow across many turns, and the read-model already IS the
// durable record of it; the deterministic Run ID (chatSummaryRunID) still
// pins the input to a message COUNT so a stale replay can't silently
// re-summarize a conversation that has since grown further.
type SummarizeChatInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo. See repos.go.
	Repo      string `json:"repo,omitempty"`
	PR        int    `json:"pr"`
	CommentID string `json:"commentId"`
}

// CommentTitlesInput starts a comment_titles Execution: it asks Haiku
// (context-only, no tools) for a short Dutch title per comment, for the batch
// of comments named in Items. Like SummarizeChatInput it carries only
// identities — the workflow reads the bodies themselves through an Activity
// (comments.Module.List), the read-model being the durable record of them —
// while each Item's BodyLen pins the version being titled, so an edited
// comment yields a different Run ID (commentTitlesRunID) instead of a deduped
// no-op that would keep the stale title forever.
type CommentTitlesInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo. See repos.go.
	Repo  string            `json:"repo,omitempty"`
	PR    int               `json:"pr"`
	Items []commentTitleRef `json:"items"`
}

// IngestInput starts an ingest Workflow Execution for one PR.
type IngestInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
}

// SubmitReviewInput starts a submit_review Workflow Execution: submitting a
// real GitHub PR-level review. Event must be "APPROVE" or "REQUEST_CHANGES"
// (validated by validateSubmitReview before the workflow ever starts). Body
// may be empty for an APPROVE; GitHub itself rejects a bodyless
// REQUEST_CHANGES, which validateSubmitReview also rejects up front.
type SubmitReviewInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo  string `json:"repo,omitempty"`
	PR    int    `json:"pr"`
	Event string `json:"event"`
	Body  string `json:"body"`
}

// ReadyForReviewInput starts a ready_for_review Workflow Execution: flip a
// draft PR to "ready for review" and optionally request reviewers. Reviewers
// is a list of user logins (validated by validateReadyForReview before the
// workflow starts); empty means "just mark ready".
type ReadyForReviewInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo      string   `json:"repo,omitempty"`
	PR        int      `json:"pr"`
	Reviewers []string `json:"reviewers"`
}

// RemoveReviewerInput starts a remove_reviewer Workflow Execution: drop the
// local reviewer from PR's requested reviewers. Deliberately carries no login —
// the Activity resolves the authenticated GitHub user itself, so a request can
// never remove somebody else.
type RemoveReviewerInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
}

// CodeWarningInput starts a code_warning Execution: an agentic Opus review
// of a PR for risks. Files is reserved for a future incremental fast-follow
// (re-checking only the files a new commit touched, piggybacking on
// pr_status's ingest-refresh delta) — it is always empty today: the only
// caller (the "/" menu's "Diepgravend onderzoek") starts a full baseline run,
// and resolveWarningScope derives the scope itself from the PR's current
// blocks whenever Files is empty.
type CodeWarningInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo — which is what every Execution started before multi-repo
	// existed carries, so replay of a stored history is unaffected — and
	// "owner/name" for any other configured repo. See repos.go.
	Repo  string   `json:"repo,omitempty"`
	PR    int      `json:"pr"`
	Files []string `json:"files,omitempty"`
}

// warningScope is resolveWarningScope's Activity result: the files being
// (re-)checked this run and how many blocks they contain — the latter bounds
// how many findings the model may report (see codeWarningWorkflow).
type warningScope struct {
	Files      []string `json:"files"`
	BlockCount int      `json:"blockCount"`
	// Title/Description/JiraDescription are the PR's own intent, read from the
	// prmeta read-model — the place a reviewer explains WHY something was done
	// the way it was, which the risk check must weigh before flagging it (see
	// warningReviewArg's own fields and warningPrompt). Empty when prmeta has
	// no row for this PR yet, or when the PR has no linked Jira ticket.
	Title           string `json:"title,omitempty"`
	Description     string `json:"description,omitempty"`
	JiraDescription string `json:"jiraDescription,omitempty"`
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
	engine *tembed.Engine
	gh     github.Client
	// ghByRepo holds one github.Client per NON-primary repo (see ghFor). Lazily
	// built, guarded by ghMu: the primary repo keeps using the injected gh field,
	// so a test's Fake stays the only client in play under SLASH_GITHUB=off.
	ghMu        sync.Mutex
	ghByRepo    map[string]github.Client
	comments    *comments.Module
	inbox       *inbox.Module
	relations   *relations.Module
	prmeta      *prmeta.Module
	callresolve *callresolve.Module
	testcovers  *testcovers.Module
	approvals   *approvals.Module
	explain     *explanations.Module
	// reviewerusage counts how often each reviewer was assigned through the
	// ready_for_review flow (most-used-first sorting of the picker). Set
	// post-construction in newTasks (not a NewTaskManager param) to avoid
	// churning every test call site; a nil store makes bumpReviewerUsage a
	// no-op, like the other module-guarded activities.
	reviewerusage *reviewerusage.Module
	// commentignore records which PR-wide comments are hidden from the block
	// index. Set post-construction in newTasks (like reviewerusage) rather
	// than as a NewTaskManager param, to avoid churning every existing
	// test call site; a nil store makes saveCommentIgnore a no-op, like the
	// other module-guarded activities.
	commentignore *commentignore.Module
	// chat is the claude_chat conversation read-model. Set post-construction in
	// newTasks (like reviewerusage/commentignore) rather than as a
	// NewTaskManager param, to avoid churning every existing test call site; a
	// nil store makes the chat Activities no-ops, like the other
	// module-guarded activities.
	chat *chat.Module
	// autowarn is the on/off preference for the automatic code_warning trigger
	// (see autoStartCodeWarning). Set post-construction in newTasks (like
	// reviewerusage/commentignore/chat) rather than as a
	// NewTaskManager param; a nil store makes AutoWarnEnabled report "enabled"
	// (the default) and saveAutoWarnEnabled a no-op.
	autowarn *autowarn.Module
	// autoingestpref is the repo-wide preference for AUTOMATIC review-tree
	// generation ("off"|"own"|"all"), read by autoIngestOwnPRs inside the
	// refreshInbox Activity. Set post-construction in newTasks like the stores
	// above; a nil store makes AutoIngestPrefMode report "own" (the default)
	// and saveAutoIngestPrefMode a no-op.
	autoingestpref *autoingestpref.Module
	// langpref is the repo-wide LANGUAGE preference per output type
	// ("ui"|"explain"|"reply"), read by LangFor while an Activity builds a
	// Claude prompt and by GET /api/langpref. Set post-construction like the
	// stores above; a nil store makes LangFor report "nl" (the default) and
	// saveLangPref a no-op — i.e. exactly the pre-existing behaviour.
	langpref *langpref.Module
	// warndismiss remembers which AI risk findings the reviewer already
	// resolved or deleted, so the next code_warning run does not raise them
	// again. Set post-construction like the stores above; a nil store makes
	// the dismissal recording a no-op and the filter a pass-through, i.e.
	// exactly the pre-existing behaviour.
	warndismiss *warndismiss.Module
	// warnreviewed remembers, per file, the sha256 of the head content
	// code_warning last successfully reviewed, so a later run can skip a file
	// that hasn't changed since instead of paying for another agentic Opus
	// call on it. Set post-construction like the stores above; a nil store
	// makes resolveWarningScope's filter a pass-through (every file stays in
	// scope, i.e. the pre-existing behaviour) and the recording in
	// runAgenticReview a no-op.
	warnreviewed *warnreviewed.Module
	// jiranotify is the read-model of the reviewer's Jira notification feed
	// (the bell menu), written by the jira_inbox tracker's Activities. Set
	// post-construction like the stores above; a nil store makes those
	// Activities no-ops and leaves GET /api/jira/notifications empty.
	jiranotify *jiranotify.Module
	// jiraissues is the read-model behind /pr-overview's "Planning" and "Todo"
	// sections, written by the jira_issues tracker's Activity. Set
	// post-construction like the stores above; a nil store makes that Activity
	// a no-op and leaves GET /api/jira/issues empty.
	jiraissues *jiraissues.Module
	// plan is the read-model behind the /plan/<JIRA-KEY> planning page, written
	// by the `plan` tracker's Activities (see plan_workflow.go). Set
	// post-construction like the stores above; a nil store makes those
	// Activities no-ops and leaves GET /api/plan empty.
	plan    *plan.Module
	claude  claude.Client
	jira    jira.Client
	db      *sql.DB
	dataDir string
	// appDataDir is the directory settings.json/praise-words.json live in
	// (server.dataDir in api.go — the same dir /api/settings, /api/names and
	// /api/praisewords already read from). NOT the same as dataDir above:
	// dataDir is the workflow store/worktree dir (next to the DB), and the two
	// only coincide by default — a test run (or any deployment) that points
	// -db and -data at different trees needs this to be set explicitly (see
	// runServe in main.go). Falls back to dataDir when never set (appDataDir()
	// below), matching every pre-existing call site that only ever had ONE
	// dataDir to begin with.
	appDataDir string
	repo       string
	interval   time.Duration // fast cadence (reviewer active)
	idle       time.Duration // slow cadence + PR-state check (reviewer idle)
	logf       func(string, ...any)

	// baseCtx is the server-lifetime context background pollers spawned outside
	// a request (e.g. ensurePRStatus's fresh-poller spawn) run under — a
	// request-scoped ctx would be cancelled the moment the handler that started
	// it returns. Set via SetRuntime; nil (and runtimeReady false) for a
	// one-shot CLI caller, which never spawns background pollers.
	baseCtx      context.Context
	runtimeReady bool

	// ready gates every background poller/trigger spawned at boot
	// (pollIngestRefresh, pollImportComments, pollInbox, the initial
	// EnsureInbox refresh, and the automatic code_warning worker) behind
	// the HTTP listener actually being bound —
	// see waitReady/ArmReadyGate/MarkReady. Defaults to an already-closed
	// channel (NewTaskManager) so every existing test/CLI caller, which never
	// arms the gate, behaves exactly as before (no wait at all).
	ready chan struct{}
	// codeWarnQueue serializes automatic code_warning starts through a single
	// worker (see enqueueAutoStartCodeWarning/runCodeWarnWorker) instead of an
	// unbounded goroutine per trigger, so a burst of PRs with new commits
	// after downtime never launches dozens of concurrent Opus calls (and their
	// workflows.db writes) at once — mirrors Engine.Recover's own "drain
	// serially" precaution for its background low-priority runs.
	codeWarnQueue     chan prKey
	codeWarnWorkerOne sync.Once

	mu       sync.Mutex           // guards lastBeat + prRuns + relRuns + apprRuns + ignRuns + inboxRun + autoWarnRun + importPolled
	lastBeat map[string]time.Time // code-comment/inbox Run ID → last heartbeat
	// Keyed by prKey — (repo, number), see repos.go — so a PR 12 in a second
	// repo can never be handed the primary repo's PR 12 tracker.
	prRuns            map[prKey]string // PR → pr_status Run ID
	relRuns           map[prKey]string // PR → build_relations Run ID
	apprRuns          map[prKey]string // PR → approve Run ID
	ignRuns           map[prKey]string // PR → ignore_comment Run ID
	inboxRun          string           // pr_inbox Run ID (one per repo/process)
	jiraRun           string           // jira_inbox Run ID (one per process — the feed is per-user, not per-repo)
	jiraStatus        jiraNotifyStatus // last refresh outcome, in-memory only (see jira_notifications.go)
	jiraIssuesRun     string           // jira_issues Run ID (one per process — the issue lists are per-user, see jira_issues.go)
	autoWarnRun       string           // auto_warn Run ID (one per repo/process)
	autoIngestPrefRun string           // auto_ingest_pref Run ID (one per repo/process)
	langPrefRun       string           // lang_pref Run ID (one per repo/process)
	appSettingsRun    string           // app_settings Run ID (one per process, no repo scope)
	importPolled      map[string]bool  // imported-thread Run ID → poller running (dedup, operational)
	avatarTried       map[string]bool  // imported-thread Run ID → avatar backfill attempted (dedup, operational)
	// polling/pollRestart gate the ONE GitHub reply poller per comment thread
	// (see beginPolling/endPolling). A thread's poller now stops while the
	// comment is resolved and is restarted by the reopenComment Activity, so
	// several callers (that Activity, ResumePolling, importPRComments) can race
	// to start one; pollRestart closes the "a restart was requested exactly
	// while the old poller was exiting" window. Purely in-memory/operational,
	// like lastBeat.
	polling     map[string]bool
	pollRestart map[string]bool

	// autoIngestTried dedups the automatic-ingest trigger (autoIngestOwnPRs):
	// once a PR has been handed to autoIngestOne, later refreshInbox runs (the
	// pr_inbox poll cadence, every 1-10 min) must not start a second Execution
	// for it while the first is still generating. Purely in-memory/operational,
	// like polling/importPolled above — a restart just loses this memory, which
	// only means a PR still without a graph may be retried once more; StartIngest
	// itself is safe to run twice for the same PR.
	autoIngestTried map[prKey]bool

	// meCache caches the authenticated GitHub user (see CurrentUser) for the
	// process lifetime: it never changes while the server runs, so one `gh api
	// user` is enough. Purely in-memory/operational, like lastBeat — it touches
	// no read-model or workflow history.
	meMu    sync.Mutex
	meUser  github.Collaborator
	meKnown bool
}

// NewTaskManager wires the modules onto engine and registers the workflows.
func NewTaskManager(engine *tembed.Engine, gh github.Client, cs *comments.Module, ib *inbox.Module, rel *relations.Module, pm *prmeta.Module, cr *callresolve.Module, tc *testcovers.Module, ap *approvals.Module, ex *explanations.Module, cl claude.Client, jr jira.Client, db *sql.DB, dataDir, repo string) *TaskManager {
	closedGate := make(chan struct{})
	close(closedGate)
	m := &TaskManager{
		engine: engine, gh: gh, comments: cs, inbox: ib, relations: rel, prmeta: pm, callresolve: cr, testcovers: tc, approvals: ap, explain: ex, claude: cl, jira: jr, db: db, dataDir: dataDir, repo: repo,
		interval: pollInterval, idle: idlePollInterval,
		lastBeat: map[string]time.Time{}, prRuns: map[prKey]string{}, relRuns: map[prKey]string{}, apprRuns: map[prKey]string{}, ignRuns: map[prKey]string{},
		importPolled:    map[string]bool{},
		avatarTried:     map[string]bool{},
		polling:         map[string]bool{},
		pollRestart:     map[string]bool{},
		autoIngestTried: map[prKey]bool{},
		logf:            log.Printf,
		ready:           closedGate,
		// Buffered generously: enqueue must never block the deterministic
		// Activity that calls it. A full queue (extremely unlikely — it would
		// take hundreds of PRs signalling "new commits" between two drains of
		// a single serial worker) just drops the trigger with a log line,
		// same "best-effort automatic check" spirit as autoStartCodeWarning's
		// own enabled-check.
		codeWarnQueue: make(chan prKey, 256),
	}

	// Activity: fetch the inbox from GitHub and store it in the read-model
	// (write, workflow-driven). Best-effort: on a fetch failure we keep the last
	// good snapshot so the workflow never fails on a transient GitHub hiccup.
	engine.RegisterActivity("refreshInbox", func(ctx context.Context, in []byte) ([]byte, error) {
		snap, err := buildInboxSnapshot(ctx, m.db, m.prmeta)
		if err != nil {
			m.logf("pr_inbox: refresh skipped: %v", err)
			return json.Marshal(inboxRefreshResult{})
		}
		// The "💬 n" badge counts slash's view of GitHub-imported comments only
		// (source: github) — never a slash-placed local one (source: ""/"ui",
		// e.g. a private "Alleen voor mijzelf" note or the auto-created
		// Claude-chat anchor comment, see ensureClaudeAnchorForNew in
		// RelatedPanel.mjs). A local comment was never posted to GitHub, so it
		// must not inflate a count meant to mirror the real GitHub comment
		// count. comments.List includes both; resolving a real GitHub comment
		// in slash still lowers the badge directly. Read-only enrichment inside
		// the Activity — no new write path.
		if m.comments != nil {
			for si := range snap.Sections {
				for pi := range snap.Sections[si].PRs {
					pr := &snap.Sections[si].PRs[pi]
					cs, err := m.comments.List(ctx, canonRepo(pr.Repo), pr.Number)
					if err != nil {
						continue // keep the GitHub count on a read hiccup
					}
					open := 0
					for _, c := range cs {
						if c.Source != "github" {
							continue
						}
						switch c.Status {
						case "resolved", "deleting", "deleted":
							// excluded
						default:
							open++
						}
					}
					pr.Comments = open
				}
			}
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

		// Automatically generate a review tree for every PR the reviewer's own
		// auto_ingest_pref preference covers (see autoIngestOwnPRs) — "mijn eigen
		// prs, daarvan mogen de trees automatisch worden gegenereerd". Fire-and-
		// forget: never blocks this Activity or the "refresh" Signal a page load
		// awaits synchronously (SignalWorkflow runs the whole Activity inline).
		myLogin := snap.GeneratedFor
		if cfg := settings(m.appDataDirOrDefault()); cfg.Me.Login != "" {
			myLogin = cfg.Me.Login
		}
		m.autoIngestOwnPRs(ctx, myLogin, snap.Sections)

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

	// Activity: record the comment's own GitHub review-comment id, once known —
	// either an import's ImportedRootID or a fresh post's returned RootID (see
	// the RootID switch in taskCodeCommentWorkflow). A no-op for id <= 0 (local
	// note, or a post that didn't happen/failed) — see comments.SetGithubID.
	engine.RegisterActivity("saveCommentGithubID", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID       string `json:"id"`
			GithubID int64  `json:"githubId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.SetGithubID(ctx, arg.ID, arg.GithubID)
	})

	// Activity: fill in the author's GitHub avatar URL on a comment imported
	// before that field existed (the import never re-runs its Execution, so the
	// glue backfills through an "avatar" ReactionSignal — see
	// taskCodeCommentWorkflow). A no-op for an empty url.
	engine.RegisterActivity("saveCommentAvatar", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID        string `json:"id"`
			AvatarURL string `json:"avatarUrl"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.SetAvatarURL(ctx, arg.ID, arg.AvatarURL)
	})

	// Activity: move a comment's row anchor after a new commit re-scanned its
	// block (the "reanchor" ReactionSignal action — see reanchor.go for how the
	// new anchor is derived). Pure metadata: the body and the stored code snippet
	// the matcher searches for are left alone.
	engine.RegisterActivity("saveCommentAnchor", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID          string `json:"id"`
			RowStart    int    `json:"rowStart"`
			RowEnd      int    `json:"rowEnd"`
			Seg         string `json:"seg"`
			Gran        string `json:"gran"`
			AnchorState string `json:"anchorState"`
			Path        string `json:"path"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.SetAnchor(ctx, arg.ID, arg.RowStart, arg.RowEnd, arg.Seg, arg.Gran, arg.AnchorState, arg.Path)
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
		id, err := m.ghFor(c.Repo).PostReviewComment(ctx, c.PR, c.File, start, end, side, body)
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

	// Activity: overwrite the root comment's own body (write, workflow-driven)
	// — the reviewer editing their own already-placed comment. Leaves every
	// other column (status, anchor, code snippet) untouched.
	engine.RegisterActivity("editCommentBody", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID   string `json:"id"`
			Body string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.UpdateBody(ctx, arg.ID, arg.Body)
	})

	// Activity: overwrite one reply's own body (write, workflow-driven) — the
	// reviewer editing a reply they wrote earlier in this thread.
	engine.RegisterActivity("editReactionBody", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID   string `json:"id"`
			Body string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.UpdateReactionBody(ctx, arg.ID, arg.Body)
	})

	// Activity: record the GitHub comment id a reply was mirrored to (write,
	// workflow-driven) — a no-op for id <= 0, mirrors saveCommentGithubID for
	// the root. Needed so a later edit of that same reply knows what to PATCH.
	engine.RegisterActivity("saveReactionGithubID", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID       string `json:"id"`
			GithubID int64  `json:"githubId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return nil, cs.SetReactionGithubID(ctx, arg.ID, arg.GithubID)
	})

	// Activity: PATCH an already-posted review comment's body on GitHub
	// (best-effort — used for both a thread's root comment and any of its
	// replies, since GitHub represents a review-comment reply as a review
	// comment too).
	engine.RegisterActivity("editGithubReviewComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			CommentID int64  `json:"commentId"`
			Body      string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.CommentID == 0 {
			return nil, nil
		}
		if err := gh.EditReviewComment(ctx, arg.CommentID, arg.Body); err != nil {
			m.logf("task_code_comment: github edit review comment skipped: %v", err)
		}
		return nil, nil
	})

	// Activity: PATCH an already-posted issue comment's body on GitHub
	// (best-effort — used for a PR-wide thread's root comment and any of its
	// replies, both of which mirror as plain issue comments).
	engine.RegisterActivity("editGithubIssueComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			CommentID int64  `json:"commentId"`
			Body      string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.CommentID == 0 {
			return nil, nil
		}
		if err := gh.EditIssueComment(ctx, arg.CommentID, arg.Body); err != nil {
			m.logf("task_code_comment: github edit issue comment skipped: %v", err)
		}
		return nil, nil
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

	// Activity: put a resolved comment back on "open" (write, workflow-driven) —
	// the read-model half of the "unresolve" action. It also restarts the
	// thread's GitHub reply poller, which stopped itself while the thread was
	// resolved (see poll/beginPolling): starting a goroutine writes nothing
	// durable, so that part is operational bookkeeping, not a second write path.
	// Idempotent: re-running it on replay just re-sets the same status and
	// re-claims the same single poller slot.
	engine.RegisterActivity("reopenComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID     string `json:"id"`
			Repo   string `json:"repo,omitempty"`
			PR     int    `json:"pr"`
			RootID int64  `json:"rootId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if err := cs.SetStatus(ctx, arg.ID, "open"); err != nil {
			return nil, err
		}
		// Only a thread with a GitHub root has replies to poll for, and only a
		// running server has a context to poll under (a one-shot CLI caller has
		// neither, see baseCtx).
		if arg.RootID != 0 && m.baseCtx != nil {
			prRunID, err := m.ensurePRStatus(arg.Repo, arg.PR)
			if err != nil {
				m.logf("task_code_comment: reopen ensure pr_status pr=%d: %v", arg.PR, err)
				prRunID = ""
			}
			go m.poll(m.baseCtx, arg.ID, arg.Repo, arg.PR, arg.RootID, prRunID)
		}
		return nil, nil
	})

	// Activity: delete the GitHub review comment (best-effort — a failure must
	// not block removing our own record of it).
	engine.RegisterActivity("deleteGithubComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo   string `json:"repo,omitempty"`
			PR     int    `json:"pr"`
			RootID int64  `json:"rootId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if err := m.ghFor(arg.Repo).DeleteComment(ctx, arg.PR, arg.RootID); err != nil {
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

	// Activity: reply on GitHub to a UI reaction (best-effort). Returns the new
	// reply's own GitHub comment id (as a postResult) so it can be recorded
	// against the reaction — needed later to PATCH that same reply if the
	// reviewer edits it (see the "edit" Action above).
	engine.RegisterActivity("replyGithub", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo   string `json:"repo,omitempty"`
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
		id, err := gh.Reply(ctx, arg.PR, arg.RootID, arg.Body)
		if err != nil {
			m.logf("task_code_comment: github reply skipped: %v", err)
			return json.Marshal(postResult{})
		}
		return json.Marshal(postResult{RootID: id})
	})

	// Activity: resolve ("Resolve conversation") the GitHub review-diff thread of
	// a comment when the reviewer resolves it in the app (best-effort). A PR-wide
	// thread has no GitHub resolve concept, so this is only called for review-diff
	// threads.
	engine.RegisterActivity("resolveGithubThread", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo   string `json:"repo,omitempty"`
			PR     int    `json:"pr"`
			RootID int64  `json:"rootId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if err := m.ghFor(arg.Repo).ResolveReviewThread(ctx, arg.PR, arg.RootID); err != nil {
			m.logf("task_code_comment: github resolve thread skipped: %v", err)
		}
		return nil, nil
	})

	// Activity: reopen ("Unresolve conversation") the GitHub review-diff thread
	// of a comment the reviewer just unresolved in the app (best-effort) — the
	// exact mirror of resolveGithubThread above, same PR-wide carve-out.
	engine.RegisterActivity("unresolveGithubThread", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo   string `json:"repo,omitempty"`
			PR     int    `json:"pr"`
			RootID int64  `json:"rootId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if arg.RootID == 0 {
			return nil, nil
		}
		if err := gh.UnresolveReviewThread(ctx, arg.PR, arg.RootID); err != nil {
			m.logf("task_code_comment: github unresolve thread skipped: %v", err)
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
			Repo string `json:"repo,omitempty"`
			PR   int    `json:"pr"`
			Body string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		id, err := m.ghFor(arg.Repo).PostIssueComment(ctx, arg.PR, arg.Body)
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
		setIngestStage(input.Repo, input.PR, IngestStageWorktrees)
		defer clearIngestStage(input.Repo, input.PR)
		shas, err := prepareIngestWorktrees(ctx, m.dataDir, input.Repo, input.PR)
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
			Repo string       `json:"repo,omitempty"`
			PR   int          `json:"pr"`
			Shas worktreeSHAs `json:"shas"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		setIngestStage(arg.Repo, arg.PR, IngestStageScan)
		defer clearIngestStage(arg.Repo, arg.PR)
		res, err := scanAndStoreIngestBlocks(ctx, m.db, m.dataDir, arg.Repo, arg.PR, arg.Shas)
		if err != nil {
			return nil, fmt.Errorf("ingest: scan and store blocks: %w", err)
		}
		// The blocks table was just fully swapped, so a tab already open on this
		// PR is showing a stale tree (see eventBlocksChanged, eventbus.go). Also
		// closes out any "wordt bijgewerkt" pill this PR still had pending — the
		// tree is now current with everything landed so far, see
		// chat_refresh_pending.go. A full (re-)ingest is never itself the result
		// of a reviewer's own chat landing (that always goes through the delta
		// path below), so this publishes with no LandedFiles — a fresh tab
		// always takes the ordinary manual staleTreeRow path.
		clearChatRefreshPendingFiles(arg.Repo, arg.PR)
		publishBlocksChanged(arg.Repo, arg.PR, nil)
		return json.Marshal(res)
	})

	// Activity: incrementally refresh a PR's blocks after new commits landed on
	// its head ref (write — scoped to just the changed files via
	// upsertPRFileBlocks; falls back to a full ingest if the base SHA itself
	// moved). Driven by pr_status's SignalPRState branch, on the ingest-refresh
	// poller's cadence (pollIngestRefresh).
	engine.RegisterActivity("refreshIngestDelta", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo    string `json:"repo,omitempty"`
			PR      int    `json:"pr"`
			BaseSHA string `json:"baseSHA"`
			HeadSHA string `json:"headSHA"`
			// LandedFiles: only set by refreshTreeAfterLanding (a reviewer's own
			// just-landed chat edit) via PRStateSignal.LandedFiles — see its own
			// doc comment. Empty for the ordinary colleague-push poller
			// (pollIngestRefresh), which builds a PRStateSignal with no such
			// files at all.
			LandedFiles []string `json:"landedFiles,omitempty"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		res, err := refreshIngestDelta(ctx, m.db, m.dataDir, arg.Repo, arg.PR, arg.BaseSHA, arg.HeadSHA)
		if err != nil {
			return nil, fmt.Errorf("pr_status: refresh ingest delta: %w", err)
		}
		// Only when blocks really moved: a Skipped refresh (head SHA unchanged,
		// or a delta with no changed files) wrote nothing, so nudging the tab
		// would put a "new commits" notice on screen with nothing behind it.
		if res != nil && !res.Skipped {
			// The tree is now current with everything landed so far for this PR —
			// close out any "wordt bijgewerkt" pill, same as scanAndStoreBlocks
			// above.
			clearChatRefreshPendingFiles(arg.Repo, arg.PR)
			// arg.LandedFiles travels straight into the published event's own
			// payload — computed and sent atomically, in the SAME Activity call
			// that just swapped the blocks table, so the frontend never has to
			// correlate this against a separately-fetched, race-prone read model
			// (see the "wordt bijgewerkt" ordering bug in
			// .claude/docs/pending-push.md). Still purely a UI-routing hint: the
			// frontend always re-fetches GET /api/blocks for real before acting on
			// it — an event is never the source of truth
			// (.claude/docs/server-events.md).
			publishBlocksChanged(arg.Repo, arg.PR, arg.LandedFiles)
		}
		return json.Marshal(res)
	})

	// Activity: move every stored comment/approval anchor the refresh just
	// invalidated onto the rows it now belongs to (reanchor.go works out what those
	// are; this applies them), and — for a comment that just became orphaned —
	// consider auto-resolving it (comment_autoresolve.go) when it was asking for
	// exactly that code to be removed.
	//
	// Planning is a read — the read-models, the blocks table, the worktrees and
	// `git show` — and applying goes exclusively through the sanctioned write
	// paths: a "reanchor" Signal to each comment's own Execution, an ordinary
	// resolving reply Signal for an auto-resolved one, and the approve tracker's
	// existing "set" Signal per remapped block. So the write boundary holds, and
	// each change lands in its own comment's replayable history.
	//
	// Plan and apply live in ONE Activity, mirroring supersedeFileWarnings (which
	// likewise lists comments and signals each of them): the alternative — return
	// the plan and let the workflow body loop over it — would put a variable number
	// of Signal sends (and, for auto-resolve, a variable number of LLM calls) in the
	// body, which only stays replay-deterministic because it's driven off a
	// recorded result. One Activity is simply a fixed position in the history and
	// needs no such argument. Best-effort per anchor: a comment whose Execution has
	// already completed can't be signalled again, and that must not sink the rest
	// of the pass.
	engine.RegisterActivity("reanchorAfterRefresh", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo         string   `json:"repo,omitempty"`
			PR           int      `json:"pr"`
			PrevBaseSHA  string   `json:"prevBaseSHA"`
			PrevHeadSHA  string   `json:"prevHeadSHA"`
			ChangedFiles []string `json:"changedFiles"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if len(arg.ChangedFiles) == 0 || cs == nil {
			return json.Marshal(reanchorResult{})
		}
		blocks, err := blocksByPR(m.db, arg.Repo, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("reanchor: load blocks: %w", err)
		}
		cmts, err := cs.List(ctx, arg.Repo, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("reanchor: load comments: %w", err)
		}
		var aps []approvals.Approval
		if m.approvals != nil {
			if aps, err = m.approvals.List(ctx, arg.Repo, arg.PR); err != nil {
				return nil, fmt.Errorf("reanchor: load approvals: %w", err)
			}
		}
		plan := planReanchor(ctx, m.dataDir, arg.PR, arg.ChangedFiles,
			arg.PrevBaseSHA, arg.PrevHeadSHA, cmts, aps, blocks)
		if plan.empty() {
			return json.Marshal(reanchorResult{})
		}

		// Looked up by RunID (== comment ID) below, once, for the auto-resolve
		// check — it needs the comment's own Body/Code/Status/Reactions, none of
		// which commentAnchorUpdate carries.
		byRunID := make(map[string]comments.Comment, len(cmts))
		for _, c := range cmts {
			byRunID[c.RunID] = c
		}

		res := reanchorResult{}
		for _, u := range plan.Comments {
			anchor := u
			if err := m.Signal(u.RunID, ReactionSignal{
				ID: "sys-" + newUIReactionID(), Source: "system",
				Action: "reanchor", Anchor: &anchor,
			}); err != nil {
				m.logf("reanchor: comment %s skipped: %v", u.RunID, err)
				continue
			}
			res.Comments++

			// A comment whose anchor just became orphan (its symbol is entirely gone
			// from the PR) may have been asking for exactly that — auto-resolve it
			// once shouldConsiderAutoResolve's guardrails hold AND a cheap model
			// confidently agrees. See comment_autoresolve.go for the full guardrails
			// and why resolving is irreversible.
			if u.AnchorState == comments.AnchorOrphan {
				if orig, ok := byRunID[u.RunID]; ok && shouldConsiderAutoResolve(orig) &&
					classifyRemovalRequest(ctx, m.claude, orig.Body, orig.Code) {
					if err := m.Signal(u.RunID, ReactionSignal{
						ID: "sys-" + newUIReactionID(), Source: "ai",
						Author: autoResolveAuthor, Body: autoResolveNote, Done: true,
					}); err != nil {
						m.logf("reanchor: auto-resolve %s skipped: %v", u.RunID, err)
					} else {
						res.AutoResolved++
					}
				}
			}
		}
		if len(plan.Approvals) > 0 {
			runID, err := m.EnsureApprovals(arg.Repo, arg.PR)
			if err != nil {
				m.logf("reanchor: no approve tracker for pr %d: %v", arg.PR, err)
			} else {
				for _, r := range plan.Approvals {
					if err := m.engine.SignalWorkflow(runID, SignalSet, ApprovalSignal{
						BlockID: r.BlockID, Rows: r.Rows, Calls: r.Calls, Anchors: r.Anchors,
					}); err != nil {
						m.logf("reanchor: approvals for %s skipped: %v", r.BlockID, err)
						continue
					}
					res.Approvals++
				}
			}
		}
		log.Printf("reanchor pr %d: moved %d comment anchor(s), %d approval set(s), auto-resolved %d comment(s)",
			arg.PR, res.Comments, res.Approvals, res.AutoResolved)
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
		setIngestStage(input.Repo, input.PR, IngestStageRelations)
		defer clearIngestStage(input.Repo, input.PR)
		blocks, err := blocksByPR(m.db, input.Repo, input.PR)
		if err != nil {
			return nil, fmt.Errorf("build_relations: load blocks: %w", err)
		}
		rels := buildRelations(m.dataDir, input.PR, blocks)
		if err := m.relations.Replace(ctx, input.Repo, input.PR, rels); err != nil {
			return nil, fmt.Errorf("build_relations: save: %w", err)
		}
		// Also resolve method calls statically (resolved/unresolved) into the
		// callresolve read-model. UpsertGo preserves LLM-owned rows. A changed
		// migration's Schema::create/table → model mapping (resolveMigrationModels)
		// and a test's #[DataProvider(...)]/@dataProvider annotation
		// (resolveDataProviders, see .claude/docs/tembed-workflows.md, "PHPUnit
		// data providers") ride the same read-model/keep-set (see
		// .claude/docs/tembed-workflows.md, "migration → model") so their rows
		// are never pruned as stale.
		calls := resolveCalls(m.dataDir, input.PR, blocks)
		calls = append(calls, resolveTSCalls(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveMigrationModels(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveDataProviders(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveTranslations(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveEnumValueTranslations(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveVueTranslations(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveClassMembers(m.dataDir, input.PR, blocks)...)
		calls = append(calls, resolveConfigCalls(m.dataDir, input.PR, blocks)...)
		// An interface method that already got a concrete "A" parent — either
		// the both-changed interfaceImplementationDetector edge above (rels)
		// or any resolved/found call above (calls, e.g. resolveCalls' rule
		// 3a) — must not ALSO get "B"'s up-to-2 implementations: exclusive
		// per interface method (see interfaces.go).
		claimedIfaceIDs := claimedInterfaceMethodIDs(input.PR, rels, calls)
		calls = append(calls, resolveInterfaceImplementations(m.dataDir, input.PR, blocks, claimedIfaceIDs)...)
		if m.callresolve != nil {
			if err := m.callresolve.UpsertGo(ctx, calls); err != nil {
				return nil, fmt.Errorf("build_relations: save calls: %w", err)
			}
			// Drop stale rows: every (caller, call) pair the scan no longer emits —
			// the caller block left the PR, or the call site is no longer on a
			// changed line.
			if err := m.callresolve.Prune(ctx, input.Repo, input.PR, calls); err != nil {
				return nil, fmt.Errorf("build_relations: prune calls: %w", err)
			}
			// Automatically start an LLM search for every call the Go resolver
			// just marked unresolved that hasn't used up its attempts yet (see
			// autoStartResolveCall/groupUnresolvedCalls) — the server-side
			// counterpart of the frontend's own automatic trigger
			// (startCallSearch, home.mjs). Grouped per caller (and search
			// generation), one Execution per group, started in its own goroutine
			// so this Activity — and thus
			// ingest/EnsureRelations/prStatusWorkflow's delta-refresh — never
			// waits on a live claude call. StartResolveCall's own deterministic
			// Run ID makes a repeat request for an unchanged unresolved set at
			// the same generation an idempotent no-op, and autoStartResolveCall
			// counts a call's earlier attempts in the durable workflow history
			// (resolveCallAttempts), not in the callresolve read-model's own
			// status column, so the cap holds across any number of rebuilds and
			// any restart. THIS is also where the one retry round for a row
			// stranded at unresolved lands: it fires on the next relations build
			// of that PR, not on a page load (a page load must not walk the whole
			// event history). The frontend trigger stays in place as a safety net
			// — e.g. for a PR whose relations were only ever refreshed headlessly
			// via `slash relations`, which never runs this Activity at all (see
			// .claude/docs/tembed-workflows.md).
			go m.autoStartResolveCall(input.Repo, input.PR, calls, blocks)
			// "Something changed in callresolve" — a tab already open on this
			// PR refetches GET /api/callresolve instead of only learning about
			// it once it happens to select the caller block (see
			// eventCallResolveChanged, eventbus.go).
			publishCallResolveChanged(input.Repo, input.PR)
		}
		// Also detect test-coverage annotations statically (resolved/unannotated/
		// unresolved) into the testcovers read-model. UpsertGo preserves LLM-owned
		// rows (searching/found/notfound).
		covers := scanTestCovers(m.dataDir, input.PR, blocks, rels)
		if m.testcovers != nil {
			if err := m.testcovers.UpsertGo(ctx, covers); err != nil {
				return nil, fmt.Errorf("build_relations: save test covers: %w", err)
			}
			if err := m.testcovers.Prune(ctx, input.Repo, input.PR, covers); err != nil {
				return nil, fmt.Errorf("build_relations: prune test covers: %w", err)
			}
			publishTestCoversChanged(input.Repo, input.PR)
			// Automatically start an LLM search for every class-level-only
			// coverage target the Go analyzer just marked unresolved that hasn't
			// already been attempted — the server-side counterpart of the
			// frontend's own automatic trigger (startTestCoverSearch, home.mjs),
			// mirroring the resolve_call auto-search above. Own goroutine, same
			// reasoning: this Activity must never wait on a live claude call.
			go m.autoStartResolveTestCovers(input.PR, covers, blocks)
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
		return nil, m.callresolve.SaveSearching(ctx, arg.Repo, arg.PR, arg.CallerID, arg.Calls)
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
		// This is the LLM search's own result, landing well after
		// build_relations' Go-only pass and after POST /api/ingest already
		// returned (see autoStartResolveCall) — the exact moment a tab already
		// open on this PR needs telling.
		if len(entries) > 0 {
			publishCallResolveChanged(entries[0].Repo, entries[0].PR)
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
		return nil, m.testcovers.SaveSearching(ctx, arg.Repo, arg.PR, arg.TestID, keys)
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
		entries, err := m.testcovers.List(ctx, arg.Repo, arg.PR)
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
		// Same rationale as saveResolutions above: this is the LLM search's
		// own result, landing after build_relations' Go-only pass.
		if len(entries) > 0 {
			publishTestCoversChanged(entries[0].Repo, entries[0].PR)
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
	// in the input) for a short Dutch description of the unit. Shells out to
	// the claude CLI — a side effect, hence an Activity. Best-effort: a Claude
	// hiccup yields empty text (the workflow then records "failed") rather than
	// sinking the run.
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
			SystemPrompt: claude.ExplainCodeSystemPrompt + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
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

	// Activity: mark a conversation's summary as in-progress (write,
	// workflow-driven) — mirrors markExplainSearching above.
	engine.RegisterActivity("markChatSummarySearching", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg SummarizeChatInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		return nil, m.chat.SaveSummarySearching(ctx, arg.CommentID)
	})
	// Activity: ask Haiku (context-only, no tools) to summarize the
	// conversation's own transcript in at most 2 sentences. Shells out to the
	// claude CLI — a side effect, hence an Activity. Best-effort: a Claude
	// hiccup yields empty text (the workflow then records "failed") rather than
	// sinking the run.
	engine.RegisterActivity("generateChatSummary", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg SummarizeChatInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil || m.claude == nil {
			return json.Marshal(map[string]string{"text": ""})
		}
		msgs, err := m.chat.List(ctx, arg.CommentID)
		if err != nil {
			return nil, err
		}
		text, err := m.claude.Run(ctx, claude.RunRequest{
			Prompt:       chatSummaryPrompt(msgs),
			Model:        claude.ModelHaiku,
			SystemPrompt: claude.ChatSummarySystemPrompt + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
		})
		if err != nil {
			m.logf("summarize_chat: generate pr=%d comment=%s skipped: %v", arg.PR, arg.CommentID, err)
			text = ""
		}
		return json.Marshal(map[string]string{"text": strings.TrimSpace(text)})
	})
	// Activity: persist the finished (done or failed) summary (write,
	// workflow-driven).
	engine.RegisterActivity("saveChatSummary", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			CommentID string `json:"commentId"`
			Status    string `json:"status"`
			Text      string `json:"text"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		return nil, m.chat.SaveSummary(ctx, arg.CommentID, arg.Status, arg.Text)
	})

	// Activity: mark a batch of comments as "a title is being generated" (write,
	// workflow-driven) — mirrors markChatSummarySearching above, for
	// comment_titles.
	engine.RegisterActivity("markCommentTitlesSearching", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg CommentTitlesInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.comments == nil {
			return nil, nil
		}
		ids := make([]string, 0, len(arg.Items))
		for _, it := range sortCommentTitleRefs(arg.Items) {
			ids = append(ids, it.ID)
		}
		return nil, m.comments.SaveTitlesSearching(ctx, ids)
	})
	// Activity: ask Haiku (context-only, no tools) for a short Dutch title per
	// comment in the batch — ONE call for the whole batch, keyed by index (see
	// comment_titles.go). Shells out to the claude CLI, hence an Activity.
	// Best-effort: a Claude hiccup yields no titles (the workflow then records
	// every comment in the batch as failed) rather than sinking the run.
	//
	// The bodies come from the comments read-model here rather than from the
	// input, so a stale replay titles what is stored now; the Run ID already
	// pins the batch to the body LENGTHS it was started for.
	engine.RegisterActivity("generateCommentTitles", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg CommentTitlesInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		items := sortCommentTitleRefs(arg.Items)
		out := struct {
			Titles  map[string]string `json:"titles"`
			BodyLen map[string]int    `json:"bodyLen"`
		}{Titles: map[string]string{}, BodyLen: map[string]int{}}
		if m.comments == nil || m.claude == nil || len(items) == 0 {
			return json.Marshal(out)
		}
		bodies := make([]string, 0, len(items))
		kept := make([]commentTitleRef, 0, len(items))
		for _, it := range items {
			c, ok, err := m.comments.Get(ctx, it.ID)
			if err != nil {
				return nil, err
			}
			if !ok || strings.TrimSpace(c.Body) == "" {
				// Deleted (or emptied) between the start and this Activity —
				// nothing to title, and no row left to write to either.
				continue
			}
			bodies = append(bodies, c.Body)
			kept = append(kept, commentTitleRef{ID: it.ID, BodyLen: len([]rune(c.Body))})
		}
		if len(kept) == 0 {
			return json.Marshal(out)
		}
		raw, err := m.claude.Run(ctx, claude.RunRequest{
			Prompt:       commentTitlesPrompt(bodies),
			Model:        claude.ModelHaiku,
			SystemPrompt: claude.CommentTitleSystemPrompt + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
		})
		if err != nil {
			m.logf("comment_titles: generate pr=%d comments=%d skipped: %v", arg.PR, len(kept), err)
			raw = ""
		}
		titles := parseCommentTitles(raw, len(kept))
		for i, ref := range kept {
			out.BodyLen[ref.ID] = ref.BodyLen
			if t := titles[i+1]; t != "" {
				out.Titles[ref.ID] = t
			}
		}
		return json.Marshal(out)
	})
	// Activity: persist the finished batch (a title per comment, or "failed" for
	// one the model skipped) (write, workflow-driven).
	engine.RegisterActivity("saveCommentTitles", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Results []comments.TitleResult `json:"results"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.comments == nil {
			return nil, nil
		}
		return nil, m.comments.SaveTitles(ctx, arg.Results)
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
		meta, err := m.ghFor(arg.Repo).PRMeta(ctx, arg.PR)
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
				m.logf("pr_status: fetch jira %s pr=%d skipped: %v", key, arg.PR, err)
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
		meta, ok, err := m.prmeta.Get(ctx, arg.Repo, arg.PR)
		if err != nil || !ok {
			return nil, nil
		}
		files, _ := changedFilesFor(m.db, arg.PR)
		prompt := prSummaryPrompt(meta, files)
		summary, err := m.claude.Run(ctx, claude.RunRequest{
			Prompt:       prompt,
			Model:        claude.ModelHaiku,
			SystemPrompt: claude.PRSummarySystemPrompt + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
		})
		if err != nil {
			m.logf("pr_status: summary pr=%d skipped: %v", arg.PR, err)
			return nil, nil
		}
		if err := m.prmeta.SaveSummary(ctx, arg.Repo, arg.PR, strings.TrimSpace(summary)); err != nil {
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
		// Repo is threaded in with the rest of the workflow layer; a tracker
		// still only ever runs for the primary repo at this point.
		statuses, err := statusesFor(ctx, []prKey{{"", arg.PR}}, m.prmeta)
		if err != nil {
			m.logf("pr_status: fetch statuses pr=%d skipped: %v", arg.PR, err)
			return nil, nil
		}
		st, ok := statuses[statusKey("", arg.PR)]
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
		if err := m.prmeta.SaveStatuses(ctx, arg.Repo, arg.PR, st.ReviewDecision, st.ChecksTotal, checksPassed, reviewers); err != nil {
			return nil, fmt.Errorf("save pr statuses: %w", err)
		}
		// The same query already knows whether anything happened after the
		// reviewer's OWN last review/comment (myLastActivity, inbox.go) — the
		// signal the PR overview shows as "nieuw sinds jouw review". Store the
		// kind AND the moment, so the review tree can render that identical
		// line and, in the next stage, say what changed since exactly then.
		if err := m.prmeta.SaveSinceMark(ctx, arg.Repo, arg.PR, st.NewSinceKind, st.NewSinceAt, st.UpdatedAt); err != nil {
			return nil, fmt.Errorf("save pr since mark: %w", err)
		}
		return nil, nil
	})

	// Activity: stage 4 of the pr_status tracker — what changed since the
	// reviewer's own last review. Two layers, on explicit request: a
	// deterministic list of the commits that landed since that moment plus the
	// files they touched (always shown when there is anything), and a Haiku
	// explanation of those same facts on top (best-effort — a Claude hiccup
	// leaves the facts standing on their own). Only new CODE counts: comments
	// and other people's reviews are deliberately NOT part of this block.
	engine.RegisterActivity("generateSinceReviewSummary", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PRStatusInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prmeta == nil || ghDisabled() {
			return nil, nil
		}
		meta, ok, err := m.prmeta.Get(ctx, arg.Repo, arg.PR)
		if err != nil || !ok {
			return nil, nil
		}
		// No "since" moment at all (never reviewed this PR, or nothing
		// happened after it) → clear whatever an earlier run stored, so the
		// block disappears instead of going stale.
		if meta.NewSinceAt == "" {
			if err := m.prmeta.SaveSinceReview(ctx, arg.Repo, arg.PR, "", ""); err != nil {
				return nil, fmt.Errorf("clear since review: %w", err)
			}
			if meta.SinceFacts != "" || meta.SinceSummary != "" {
				publishPRMetaChanged(arg.Repo, arg.PR)
			}
			return nil, nil
		}
		changes, err := m.ghFor(arg.Repo).ChangesSince(ctx, arg.PR, meta.NewSinceAt)
		if err != nil {
			m.logf("pr_status: changes since pr=%d skipped: %v", arg.PR, err)
			return nil, nil
		}
		if len(changes.Commits) == 0 {
			if err := m.prmeta.SaveSinceReview(ctx, arg.Repo, arg.PR, "", ""); err != nil {
				return nil, fmt.Errorf("clear since review: %w", err)
			}
			if meta.SinceFacts != "" || meta.SinceSummary != "" {
				publishPRMetaChanged(arg.Repo, arg.PR)
			}
			return nil, nil
		}
		// The moment predates every commit of this PR: the "files touched
		// since" are simply the PR's own changed files (see SinceChanges.Files),
		// which we already have locally — no second API call for that.
		files := changes.Files
		if len(files) == 0 {
			files, _ = changedFilesFor(m.db, arg.PR)
		}
		facts := sinceReviewFacts(changes.Commits)
		// Nothing moved since the last generation. sinceReviewFacts is a pure
		// function of the commits + files, so an identical rendering means an
		// identical answer — skip the Haiku call and the write entirely. This
		// is what makes the RefreshSince signal (sent on every review-tree page
		// load) cheap: one gh query, no LLM, unless there is genuinely
		// something new to explain.
		if facts == meta.SinceFacts && meta.SinceSummary != "" {
			return nil, nil
		}
		summary := ""
		if m.claude != nil {
			out, err := m.claude.Run(ctx, claude.RunRequest{
				Prompt:       sinceReviewPrompt(facts, files),
				Model:        claude.ModelHaiku,
				SystemPrompt: claude.SinceReviewSystemPrompt + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
			})
			if err != nil {
				m.logf("pr_status: since-review summary pr=%d skipped: %v", arg.PR, err)
			} else {
				summary = strings.TrimSpace(out)
			}
		}
		if err := m.prmeta.SaveSinceReview(ctx, arg.Repo, arg.PR, facts, summary); err != nil {
			return nil, fmt.Errorf("save since review: %w", err)
		}
		// Nudge every open tab on this PR to refetch GET /api/pr: pollPRMeta
		// stops as soon as the statuses stage landed, so a block generated a
		// few seconds later (the Haiku call) would otherwise only appear after
		// a manual reload.
		publishPRMetaChanged(arg.Repo, arg.PR)
		return nil, nil
	})

	// Activity: persist one block's full approved state (write, workflow-driven).
	// The approvals module is the only writer of the approvals read-model.
	engine.RegisterActivity("saveApproval", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo    string                `json:"repo,omitempty"`
			PR      int                   `json:"pr"`
			BlockID string                `json:"blockId"`
			Rows    []int                 `json:"rows"`
			Calls   []string              `json:"calls"`
			Anchors []approvals.RowAnchor `json:"anchors"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.approvals == nil {
			return nil, nil
		}
		return nil, m.approvals.Replace(ctx, arg.Repo, arg.PR, arg.BlockID, arg.Rows, arg.Calls, arg.Anchors)
	})

	// Activity: stamp the moment the reviewer last had every changed row/call
	// approved in the review tree (write, workflow-driven). prmeta is the only
	// writer of its own read-model. See ApprovalSignal.FullyApproved and
	// combineSinceMoment (inbox.go).
	engine.RegisterActivity("saveFullyApprovedAt", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo string `json:"repo,omitempty"`
			PR   int    `json:"pr"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.prmeta == nil {
			return nil, nil
		}
		return nil, m.prmeta.SaveFullyApprovedAt(ctx, arg.Repo, arg.PR)
	})

	// Activity: persist the auto_warn on/off preference (write, workflow-driven).
	// The autowarn module is the only writer of the autowarn read-model.
	engine.RegisterActivity("saveAutoWarnEnabled", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo    string `json:"repo"`
			Enabled bool   `json:"enabled"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.autowarn == nil {
			return nil, nil
		}
		return nil, m.autowarn.SetEnabled(ctx, arg.Repo, arg.Enabled)
	})

	// Activity: persist the auto_ingest_pref mode (write, workflow-driven). The
	// autoingestpref module is the only writer of that read-model.
	engine.RegisterActivity("saveAutoIngestPrefMode", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo string `json:"repo"`
			Mode string `json:"mode"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.autoingestpref == nil {
			return nil, nil
		}
		return nil, m.autoingestpref.SetMode(ctx, arg.Repo, arg.Mode)
	})

	// Activity: persist one language preference (write, workflow-driven). The
	// langpref module is the only writer of that read-model.
	engine.RegisterActivity("saveLangPref", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo string `json:"repo"`
			Kind string `json:"kind"`
			Lang string `json:"lang"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.langpref == nil {
			return nil, nil
		}
		return nil, m.langpref.SetLang(ctx, arg.Repo, arg.Kind, arg.Lang)
	})

	// Activity: persist the settings page's mention-alias edit into
	// settings.json (write, workflow-driven) — saveMentionAliases (settings.go)
	// is the only writer of that file's "me.aliases" field.
	engine.RegisterActivity("saveMentionAliases", func(ctx context.Context, in []byte) ([]byte, error) {
		var aliases []string
		if err := json.Unmarshal(in, &aliases); err != nil {
			return nil, err
		}
		_, err := saveMentionAliases(m.appDataDirOrDefault(), aliases)
		return nil, err
	})

	// Activity: persist the settings page's praise-word edit into
	// praise-words.json (write, workflow-driven) — savePraiseWordsFile
	// (praisewords.go) is the only writer of that file.
	engine.RegisterActivity("savePraiseWords", func(ctx context.Context, in []byte) ([]byte, error) {
		var words []string
		if err := json.Unmarshal(in, &words); err != nil {
			return nil, err
		}
		_, err := savePraiseWordsFile(m.appDataDirOrDefault(), words)
		return nil, err
	})

	// Activity: persist the settings page's Jira-notification filter edit into
	// notify-filters.json (write, workflow-driven) — saveNotifyFiltersFile
	// (notifyfilters.go) is the only writer of that file.
	engine.RegisterActivity("saveNotifyFilters", func(ctx context.Context, in []byte) ([]byte, error) {
		var filters []string
		if err := json.Unmarshal(in, &filters); err != nil {
			return nil, err
		}
		_, err := saveNotifyFiltersFile(m.appDataDirOrDefault(), filters)
		return nil, err
	})

	// Activity: persist the settings page's Jira-credential edit into the
	// gitignored .env (write, workflow-driven) — saveEnvValues (env.go) is that
	// file's only programmatic writer. Deliberately .env and not settings.json:
	// GET /api/settings is served verbatim to the browser (see auth_status.go).
	// An empty Token keeps the stored one, so correcting the e-mail address
	// alone never wipes the token the page could not send back.
	engine.RegisterActivity("saveJiraCredentials", func(ctx context.Context, in []byte) ([]byte, error) {
		var creds JiraCredsSignal
		if err := json.Unmarshal(in, &creds); err != nil {
			return nil, err
		}
		vals := map[string]string{
			"SLASH_JIRA_EMAIL": strings.TrimSpace(creds.Email),
			"SLASH_JIRA_SITE":  strings.TrimSpace(creds.Site),
		}
		if token := strings.TrimSpace(creds.Token); token != "" {
			vals["SLASH_JIRA_TOKEN"] = token
		}
		if err := saveEnvValues(envFile, vals); err != nil {
			return nil, err
		}
		// The auth-status cache would otherwise keep reporting the old verdict
		// for up to a minute after the reviewer pressed "Opslaan".
		invalidateAuthStatus()
		return nil, nil
	})

	// Activity: append one batch of debug-mode events to debug-log.jsonl
	// (write, workflow-driven) — appendDebugLogFile (debug_log.go) is one of
	// that file's only two writers. appDataDirOrDefault(), never m.dataDir:
	// that is the settings.json/praise-words.json directory, and this file
	// lives next to them (see .claude/docs/settings-page.md's warning).
	engine.RegisterActivity("appendDebugLog", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg DebugLogInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		_, err := appendDebugLogFile(m.appDataDirOrDefault(), arg)
		return nil, err
	})

	// Activity: empty debug-log.jsonl — the settings page's "Log wissen", so
	// the reviewer can start a clean reproduction.
	engine.RegisterActivity("clearDebugLog", func(ctx context.Context, in []byte) ([]byte, error) {
		return nil, clearDebugLogFile(m.appDataDirOrDefault())
	})

	// Activity: fire-and-forget the automatic code_warning trigger for pr. This
	// Activity itself does no slow work — it only queues pr onto the single
	// serial code_warning worker and returns immediately — so
	// build_relations/prStatusWorkflow's delta-refresh never wait on a live,
	// possibly slow agentic Opus call, and a burst of PRs triggering at once
	// (e.g. after downtime) never launches more than one such call at a time.
	// On replay this Activity's recorded (empty) result is returned directly
	// without re-invoking the function (tembed only executes a live Activity
	// once), so pr is queued exactly once per real occurrence, never again on
	// replay. See TaskManager.autoStartCodeWarning for the on/off check.
	engine.RegisterActivity("autoStartCodeWarning", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo string `json:"repo,omitempty"`
			PR   int    `json:"pr"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		m.enqueueAutoStartCodeWarning(prKey{arg.Repo, arg.PR})
		return nil, nil
	})

	// Activity: store one comment's ignored state (write, workflow-driven —
	// the commentignore module is the only writer of that read-model). Set is
	// idempotent in both directions, so a replay is safe.
	engine.RegisterActivity("saveCommentIgnore", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo      string `json:"repo,omitempty"`
			PR        int    `json:"pr"`
			CommentID string `json:"commentId"`
			Ignored   bool   `json:"ignored"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.commentignore == nil {
			return nil, nil
		}
		return nil, m.commentignore.Set(ctx, arg.Repo, arg.PR, arg.CommentID, arg.Ignored)
	})

	// Activity: mark/unmark a file's GitHub "Viewed" checkbox (write,
	// workflow-driven — the only place that talks to GitHub for this).
	engine.RegisterActivity("setFileViewed", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo   string `json:"repo,omitempty"`
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
		return nil, m.ghFor(arg.Repo).MarkFileViewed(ctx, arg.PR, arg.File, arg.Viewed)
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
		return nil, m.ghFor(arg.Repo).SubmitReview(ctx, arg.PR, arg.Event, arg.Body)
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
		return nil, m.ghFor(arg.Repo).RequestReviewers(ctx, arg.PR, arg.Reviewers)
	})
	// Activity for remove_reviewer (write, workflow-driven): drop the local
	// reviewer from a PR's requested reviewers. The login is resolved here, from
	// the authenticated GitHub user, so the request itself can never name
	// somebody else. Not best-effort — a failed GitHub call must surface.
	engine.RegisterActivity("removeSelfAsReviewer", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg RemoveReviewerInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.gh == nil {
			return nil, fmt.Errorf("remove reviewer: no github client")
		}
		me, err := m.CurrentUser(ctx)
		if err != nil {
			return nil, fmt.Errorf("remove reviewer: %w", err)
		}
		if me.Login == "" {
			return nil, fmt.Errorf("remove reviewer: unknown current user")
		}
		return nil, m.ghFor(arg.Repo).RemoveReviewer(ctx, arg.PR, me.Login)
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
		blocks, err := blocksByPR(m.db, arg.Repo, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: load blocks: %w", err)
		}
		files := arg.Files
		if len(files) == 0 {
			files = distinctSortedFiles(blocks)
		}
		// Drop a file whose head content is unchanged since code_warning last
		// reviewed it (modules/warnreviewed) — the reviewer asked for "only
		// generate AI warnings on code not already checked by this flow".
		// Best-effort on a read error (like dropDismissedFindings): a
		// bookkeeping problem must never silently narrow the review.
		if m.warnreviewed != nil {
			reviewedHash, err := m.warnreviewed.Hashes(ctx, arg.Repo, arg.PR)
			if err != nil {
				m.logf("code_warning: read reviewed-file hashes: %v", err)
			} else {
				_, headDir := worktreeDirs(m.dataDir, arg.Repo, arg.PR)
				files = filesNeedingReview(files, hashHeadFiles(headDir, files), reviewedHash)
			}
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
		scope := warningScope{Files: files, BlockCount: count}
		// The PR's own intent, straight from the prmeta read-model — no extra
		// network call: the title/body and the Jira description are already
		// fetched and stored by pr_status. Best-effort: a PR whose metadata
		// hasn't landed yet simply gets a prompt without this context.
		if m.prmeta != nil {
			if meta, ok, err := m.prmeta.Get(ctx, arg.Repo, arg.PR); err == nil && ok {
				scope.Title = meta.Title
				scope.Description = meta.Body
				scope.JiraDescription = meta.JiraDesc
			}
		}
		return json.Marshal(scope)
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
			Repo  string   `json:"repo,omitempty"`
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
		list, err := cs.List(ctx, arg.Repo, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: list comments: %w", err)
		}
		removed := 0
		for _, c := range list {
			if c.Source != "ai" || !fileSet[c.File] {
				continue
			}
			// A finding the reviewer RESOLVED is dismissed for good: remember it
			// before wiping it, so the fresh pass below can't hand the same
			// remark straight back as a new open comment (see
			// modules/warndismiss). Deliberately here rather than in the
			// comment thread's own resolve branch: this Activity already runs
			// right before every review, so it needs no new step in
			// taskCodeCommentWorkflow's signal loop — and inserting one there
			// would shift the positional history of every comment thread that
			// is still open. A DELETED finding can't be caught here (its row is
			// gone), so that half is recorded at delete time instead.
			if c.Status == "resolved" && m.warndismiss != nil {
				if err := m.warndismiss.Add(ctx, arg.Repo, arg.PR, c.File, warndismiss.Fingerprint(c.Body), c.Body, time.Now().UTC().Format(time.RFC3339)); err != nil {
					m.logf("code_warning: record dismissed warning %s: %v", c.RunID, err)
				}
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

	// Activity: delete every UNANCHORED AI risk finding of a PR (Kind
	// "ai_warning", Source "ai"), through the same delete Signal
	// supersedeFileWarnings uses. Unlike that one this is NOT scoped to the
	// files under review: an orphan naming a file outside the PR's own changed
	// set never matches a scope and would otherwise survive every later run.
	// Only reached from codeWarningWorkflow's "too many orphans" branch, right
	// before the review is redone — see maxOrphanWarnings. Best-effort per
	// comment, like supersedeFileWarnings: a run that already closed itself
	// can't be signalled again and must not sink the rest of the purge.
	engine.RegisterActivity("purgeOrphanWarnings", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo string `json:"repo,omitempty"`
			PR   int    `json:"pr"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		list, err := cs.List(ctx, arg.Repo, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: list comments: %w", err)
		}
		removed := 0
		for _, c := range list {
			if c.Source != "ai" || c.Kind != "ai_warning" {
				continue
			}
			if err := m.Signal(c.RunID, ReactionSignal{
				ID: "sys-" + newUIReactionID(), Source: "ai", Action: "delete",
			}); err != nil {
				m.logf("code_warning: orphan purge skipped for %s: %v", c.RunID, err)
				continue
			}
			removed++
		}
		return json.Marshal(map[string]int{"removed": removed})
	})

	// Activity: remember that the reviewer dismissed one AI risk finding, so
	// the next code_warning run skips it (see modules/warndismiss). Driven
	// from taskCodeCommentWorkflow's delete branch; the resolve half is
	// recorded by supersedeFileWarnings instead — see its own comment.
	engine.RegisterActivity("recordWarningDismissed", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			Repo string `json:"repo,omitempty"`
			PR   int    `json:"pr"`
			File string `json:"file"`
			Body string `json:"body"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.warndismiss == nil {
			return json.Marshal(map[string]bool{"ok": false})
		}
		if err := m.warndismiss.Add(ctx, arg.Repo, arg.PR, arg.File, warndismiss.Fingerprint(arg.Body), arg.Body, time.Now().UTC().Format(time.RFC3339)); err != nil {
			return nil, fmt.Errorf("record dismissed warning: %w", err)
		}
		return json.Marshal(map[string]bool{"ok": true})
	})

	// Activity: the one agentic Opus call — reads the head worktree +
	// shells out to the claude CLI (a side effect, hence an Activity) — and
	// maps every accepted finding onto the existing comment-anchoring model
	// (anchoredWarning, code_warning.go), ready to hand to createWarningComment.
	// Also carries each finding's anchored block id (empty for an unanchored
	// PR-wide "ai_warning"), see warningToCreate.
	engine.RegisterActivity("runAgenticReview", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg warningReviewArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		list, err := cs.List(ctx, arg.Repo, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: list existing comments: %w", err)
		}
		arg.Existing = existingLineCommentsInScope(list, arg.Files)
		if m.warndismiss != nil {
			dismissed, err := m.warndismiss.List(ctx, arg.Repo, arg.PR)
			if err != nil {
				// Best-effort, like dropDismissedFindings below: a read
				// problem here must not swallow the review itself, only the
				// extra "don't repeat this reworded" context for the model.
				m.logf("code_warning: list dismissed findings: %v", err)
			} else {
				arg.PastDismissed = dismissedFindingsInScope(dismissed, arg.Files)
			}
		}
		// The language of the findings' own text: read HERE, inside the
		// Activity, not in the workflow body — reading a preference store is a
		// side effect and the workflow body must stay deterministic (see
		// .claude/rules/workflow-determinism.md).
		arg.Lang = m.LangFor(ctx, langpref.KindExplain)
		// The turn budget (see codeWarningMaxTurns's own doc comment for why
		// it's read here, inside the Activity, rather than in the workflow
		// body) — scaled with this run's own scope size, see
		// codeWarningMaxTurnsForScope.
		arg.MaxTurns = codeWarningMaxTurns(len(arg.Files))
		findings, ok := runCodeWarningReview(ctx, m.claude, m.dataDir, arg)
		// Record every file the model was actually asked to review as
		// "reviewed at this hash" (modules/warnreviewed), so the next run can
		// skip it while it stays unchanged — only once the agentic call itself
		// really happened (ok), never after a CLI/model failure degraded to no
		// findings. Best-effort: a write error here only costs a redundant
		// review next time, never a missed one.
		if ok && m.warnreviewed != nil {
			_, headDir := worktreeDirs(m.dataDir, arg.Repo, arg.PR)
			at := time.Now().UTC().Format(time.RFC3339)
			for f, hash := range hashHeadFiles(headDir, arg.Files) {
				if err := m.warnreviewed.MarkReviewed(ctx, arg.Repo, arg.PR, f, hash, at); err != nil {
					m.logf("code_warning: record reviewed file %s: %v", f, err)
				}
			}
		}
		// Drop anything the reviewer already resolved or deleted in an earlier
		// run (modules/warndismiss). Inside this Activity rather than as a step
		// of its own in codeWarningWorkflow, so the workflow body's Activity
		// sequence is unchanged; the filtered result is what gets recorded, so
		// replay stays deterministic either way.
		findings = dropDismissedFindings(ctx, m.warndismiss, arg.Repo, arg.PR, findings)
		if len(findings) == 0 {
			return json.Marshal([]warningToCreate{})
		}
		blocks, err := blocksByPR(m.db, arg.Repo, arg.PR)
		if err != nil {
			return nil, fmt.Errorf("code_warning: load blocks: %w", err)
		}
		out := make([]warningToCreate, 0, len(findings))
		for _, f := range findings {
			cc, blockID := anchoredWarning(m.dataDir, arg.PR, blocks, f)
			out = append(out, warningToCreate{Comment: cc, BlockID: blockID})
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

	engine.RegisterActivity("resolveCleanupTargets", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg CleanupInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		targets, err := resolveCleanupTargets(ctx, m.gh, m.db, m.dataDir, m.engine, arg)
		if err != nil {
			return nil, err
		}
		return json.Marshal(targets)
	})
	engine.RegisterActivity("purgePR", func(ctx context.Context, in []byte) ([]byte, error) {
		var t CleanupTarget
		if err := json.Unmarshal(in, &t); err != nil {
			return nil, err
		}
		deps := purgeDeps{
			engine: m.engine, db: m.db, dataDir: m.dataDir,
			comments: m.comments, approvals: m.approvals, relations: m.relations,
			callresolve: m.callresolve, testcovers: m.testcovers, prmeta: m.prmeta, explain: m.explain,
			commentignore: m.commentignore, chat: m.chat,
		}
		res, err := purgePR(ctx, deps, t.PR)
		if err != nil {
			return nil, err
		}
		return json.Marshal(res)
	})
	// Activity: permanently delete any run of a retired Workflow Type (see
	// retiredWorkflowTypes in cleanup.go) — unconditional, run once per
	// cleanup pass regardless of the resolved PR targets.
	engine.RegisterActivity("purgeRetiredWorkflows", func(ctx context.Context, in []byte) ([]byte, error) {
		n, err := purgeRetiredWorkflowRuns(m.engine)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]int{"deleted": n})
	})
	// Activity: permanently delete ONE failed run the reviewer chose to ignore
	// (write, workflow-driven — engine.DeleteRun, the same primitive the
	// cleanup Activities use). Only a run that is really tembed.StatusFailed
	// qualifies: an id that is unknown by now, or a run that has since been
	// retried and is running/completed again, is reported as skipped instead of
	// being torn out from under whatever is driving it. Idempotent, so replay
	// is safe — a second pass simply finds the run gone and skips it.
	engine.RegisterActivity("deleteIgnoredRun", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			RunID string `json:"runId"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		runs, err := m.engine.Runs()
		if err != nil {
			return nil, err
		}
		for _, r := range runs {
			if r.ID != arg.RunID {
				continue
			}
			if r.Status != tembed.StatusFailed {
				break
			}
			if err := m.engine.DeleteRun(r.ID); err != nil {
				return nil, fmt.Errorf("delete ignored run %s: %w", r.ID, err)
			}
			return json.Marshal(map[string]bool{"deleted": true})
		}
		return json.Marshal(map[string]bool{"deleted": false})
	})
	// Activity: permanently delete any task_code_comment run whose own comment
	// is gone from comments.db (see purgeOrphanCommentRuns) — unconditional,
	// run once per cleanup pass regardless of the resolved PR targets.
	engine.RegisterActivity("purgeOrphanCommentRuns", func(ctx context.Context, in []byte) ([]byte, error) {
		n, err := purgeOrphanCommentRuns(ctx, m.engine, m.comments)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]int{"deleted": n})
	})
	// Activity: remove any old-enough test_run run's own leftover residue (git
	// clean candidates, see test_run.go) plus that run's history entry —
	// unconditional, run once per cleanup pass, independent of the resolved PR
	// targets AND of the merged/age gate (this is about the residue's OWN age,
	// see testRunResidueAge). See sweepTestRunResidue (cleanup.go).
	engine.RegisterActivity("sweepTestRunResidue", func(ctx context.Context, in []byte) ([]byte, error) {
		n, err := sweepTestRunResidue(ctx, m.engine)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]int{"swept": n})
	})

	// Activity: drop Jira notifications older than jiraNotifyRetention (30
	// days) — the age-based half of the cleanup pass, like the test_run residue
	// sweep above. Unconditional, unrelated to any PR.
	engine.RegisterActivity("purgeJiraNotifications", func(ctx context.Context, in []byte) ([]byte, error) {
		if m.jiranotify == nil {
			return json.Marshal(map[string]int{"deleted": 0})
		}
		var arg CleanupInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		before := arg.Cutoff.Add(cleanupMergedAge - jiraNotifyRetention)
		n, err := m.jiranotify.Purge(ctx, before)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]int{"deleted": n})
	})

	// Activity: remove every planning-phase artifact directory
	// (data/plans/<KEY>, see plan_artifacts.go) that never reached a pull
	// request and has not been touched for planArtifactAge — the age-based
	// half of the plan cleanup, exactly like the test_run residue sweep above.
	// A directory that DOES carry a .pr marker is left alone here: purgePR
	// owns it, under the merged-and-old gate.
	engine.RegisterActivity("sweepPlanArtifacts", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg CleanupInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		before := arg.Cutoff.Add(cleanupMergedAge - planArtifactAge)
		n, err := sweepPlanArtifacts(m.dataDir, before)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]int{"swept": n})
	})

	// Activity: delete the completed one-shot debug_log runs (see
	// sweepDebugLogRuns, cleanup.go). The debug log itself lives in a file and
	// is deliberately kept — only the run rows those one-shots leave behind
	// are swept.
	engine.RegisterActivity("sweepDebugLogRuns", func(ctx context.Context, in []byte) ([]byte, error) {
		n, err := sweepDebugLogRuns(m.engine)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]int{"deleted": n})
	})

	// Activity: create the chat conversation row if it doesn't exist yet (write,
	// workflow-driven, idempotent). See chat_workflow.go.
	engine.RegisterActivity("ensureChatConversation", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg ClaudeChatInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		return nil, m.chat.EnsureConversation(ctx, arg.CommentID, arg.Repo, arg.PR)
	})
	// Activity: persist one turn (write, workflow-driven). Used for both the
	// reviewer's own message and — from runClaudeTurn — the assistant's reply,
	// so every write to chat_messages goes through this one path plus
	// runClaudeTurn's own save.
	//
	// Every chat Activity that changes the transcript ends with
	// publishChatChanged: a volatile "refetch me" nudge over the SSE stream
	// (chat_progress.go/eventbus.go), never the new content itself — the read
	// model stays the only source of truth, so a tab that missed the push is
	// at most one refetch behind, never wrong.
	engine.RegisterActivity("saveChatMessage", func(ctx context.Context, in []byte) ([]byte, error) {
		var msg chat.Message
		if err := json.Unmarshal(in, &msg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		if err := m.chat.SaveMessage(ctx, msg); err != nil {
			return nil, err
		}
		// The event must be scoped to the conversation's REAL repo, or a tab
		// watching a non-primary repo's PR never hears it (eventbus.go scopes
		// subscribers by statusKey(repo, pr)). Most constructors don't thread
		// Repo (SaveMessage backfills the stored row the same way), so resolve
		// it from the conversation row rather than trusting the payload.
		if msg.Repo == "" {
			if repo, ok := m.chat.ConversationRepo(ctx, msg.ConversationID); ok {
				msg.Repo = repo
			}
		}
		publishChatChanged(msg.Repo, msg.PR, msg.ConversationID)
		return nil, nil
	})
	// Activity ("wis gesprek" / chatActionClear): wipe the conversation's
	// transcript + stored claude session. Deliberately does NOT touch the PR's
	// shared local checkout (chat_checkout.go) — see chat_workflow.go's
	// chatActionClear doc comment for why that would be unsafe now that the
	// checkout is shared across every conversation of this PR.
	engine.RegisterActivity("clearChatConversation", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCommitInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat != nil {
			if err := m.chat.ClearConversation(ctx, arg.ConversationID); err != nil {
				return nil, err
			}
		}
		publishChatChanged(arg.Repo, arg.PR, arg.ConversationID)
		return nil, nil
	})
	// Activity (chatActionSeen, "Openstaande chats" blue-eye indicator): stamp
	// the conversation as read up to now (chat.Module.MarkSeen).
	engine.RegisterActivity("markChatSeen", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCommitInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		return nil, m.chat.MarkSeen(ctx, arg.ConversationID)
	})
	// Activity: record the reviewer's answer to a pending question turn (write,
	// workflow-driven).
	engine.RegisterActivity("saveChatAnswer", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			ID     string `json:"id"`
			Answer string `json:"answer"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		return nil, m.chat.SetAnswer(ctx, arg.ID, arg.Answer)
	})
	// Activity: run one ATTEMPT of a conversational Claude turn (side effect:
	// shells out via claude.Client.RunChat) and persist the assistant's reply +
	// the conversation's (possibly new) session id. Returns the saved
	// chat.Message so the workflow can tell a "question" turn apart from a
	// plain one — and a chat.KindRetrying message apart from both, which is how
	// runChatTurnWithRetries knows to sleep and call this again (with a higher
	// Attempt, hence possibly another model). See chat_workflow.go for
	// runOneClaudeTurn/parseAssistantTurn.
	engine.RegisterActivity("runClaudeTurn", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatTurnInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil || m.claude == nil {
			return json.Marshal(chatTurnResult{})
		}
		msg, action := runOneClaudeTurn(ctx, m, m.chat, m.claude, m.dataDir, arg)
		// Tasks 1+2+4: computed here, right after the turn, rather than inside
		// runOneClaudeTurn itself — keeps that function's own signature/tests
		// unchanged and keeps the "should the workflow run a further Activity"
		// decision a plain, STORED field of this Activity's result (see
		// chatTurnResult.NeedsLand's own doc comment).
		// Turn-scoped on purpose: land only when THIS turn itself got write
		// access AND actually changed the checkout (turnChangedCheckout,
		// chat_checkout.go), on top of the PR-wide "is there anything left to
		// land" check. Without the first half a plain read-only question turn
		// re-triggered the landing — and its "Wijziging staat op ..." bubble —
		// purely because the SHARED checkout already held outstanding work
		// (the reviewer's own uncommitted edits, or an earlier local commit).
		changedCheckout := turnChangedCheckout(ctx, m.dataDir, arg.Repo, arg.PR, arg.ConversationID)
		needsLand := changedCheckout && chatCheckoutNeedsLanding(ctx, m.dataDir, arg.Repo, arg.PR)
		// Logged, always: both halves answer false on any git error, and a
		// false here means the turn's edit is never landed and therefore never
		// reaches the review tree at all. A reviewer report about exactly that
		// (PR 13606) could only be traced by reading the stored Activity
		// result afterwards — see chat_land_backstop.go, which repairs the
		// state this line now explains.
		// Only when this turn touched the checkout at all: a read-only turn is
		// false/false by design and would just be noise.
		if changedCheckout {
			m.logf("claude_chat: pr=%d conversation=%s turn changed the checkout, needs landing=%v",
				arg.PR, arg.ConversationID, needsLand)
		}
		publishChatChanged(arg.Repo, arg.PR, arg.ConversationID)
		// The turn may have assigned/advanced the PR's shared work directory,
		// or raised its choice — nudge the chip/badge and the work-directory
		// overlay too, same low-cost "refetch me" broadcast as above.
		publishCheckoutChanged(arg.Repo, arg.PR)
		return json.Marshal(chatTurnResult{Message: msg, Action: action, NeedsLand: needsLand})
	})
	// Activity (Phase 4): apply a validated comment_action directive — reply to
	// or resolve the comment thread this conversation hangs on, ONLY on the
	// reviewer's own explicit request in the conversation — by signalling that
	// thread's own task_code_comment Execution via the EXISTING "reply" Signal
	// (Source "ai"), never a direct write. See chat_workflow.go
	// (applyChatCommentAction) and .claude/docs/workflows-comments.md
	// ("claude_chat").
	engine.RegisterActivity("applyChatCommentAction", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCommentActionInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		applyChatCommentAction(ctx, m, arg)
		publishChatChanged(arg.Repo, arg.PR, arg.ConversationID)
		return nil, nil
	})
	// Activity: the ONE agentic Claude run that works through a PR's open
	// comments (side effect: shells out via claude.Client.RunChat and edits files
	// in the batch's own shadow worktree). Returns only counts + whether the
	// worktree now holds work to land — see comment_batch.go.
	engine.RegisterActivity("runCommentBatch", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg commentBatchArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.claude == nil || m.comments == nil {
			return json.Marshal(commentBatchResult{})
		}
		return json.Marshal(runCommentBatch(ctx, m, m.comments, m.chat, m.claude, m.dataDir, arg))
	})
	// Activity: the ONE agentic Claude run that decides which existing tests
	// are relevant to a PR's changes and runs them (side effect: shells out via
	// claude.Client.RunChat, no Edit tool — see test_run.go). Returns only
	// counts/plan/summary + a bounded list of leftover residue paths.
	engine.RegisterActivity("runTestRun", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg testRunArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.claude == nil {
			return json.Marshal(testRunResult{})
		}
		return json.Marshal(runTestRun(ctx, m, m.claude, m.dataDir, arg))
	})
	// Activity: hand one conversation's "commit deze wijziging" request off to
	// the PR's own chat_merge queue (write: ensures + signals a DIFFERENT
	// Workflow Execution — the same cross-workflow Ensure+Signal shape
	// reanchorAfterRefresh already uses for the approve tracker). No git/claude
	// work happens here at all — see chat_merge.go (enqueueChatMerge) and
	// .claude/docs/tembed-workflows.md ("chat_merge").
	engine.RegisterActivity("enqueueChatMerge", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCommitInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		enqueueChatMerge(m, arg)
		return nil, nil
	})
	// Activity: hand one reviewer message to the claude_chat turn that is
	// RUNNING right now (write: saves that message once it really reached the
	// live CLI). In-memory delivery, durable decision — see chat_steer.go.
	engine.RegisterActivity("deliverChatSteer", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatSteerActivityInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return json.Marshal(chatSteerResult{})
		}
		return json.Marshal(deliverChatSteer(ctx, m, m.chat, arg))
	})
	// Activity: the steer fallback — nothing was running after all, so the
	// message becomes an ordinary next turn via the conversation's own
	// claude_chat "message" Signal (write: signals a DIFFERENT Execution, the
	// same cross-workflow shape enqueueChatMerge uses). Deliberately called
	// asynchronously by chatSteerWorkflow, since this blocks on the busy
	// conversation's run lock.
	engine.RegisterActivity("forwardChatSteerAsMessage", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatSteerActivityInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		forwardChatSteerAsMessage(m, arg)
		return nil, nil
	})
	// Activity: resolve a chat.KindCleanupChoice bubble left by a cancelled
	// shell attempt (offerCancelCleanupIfDirty, chat_workflow.go) — discard/
	// stash/keep whatever it left in the PR's shared checkout. Deliberately
	// never calls a Claude client and never resumes the original request; see
	// applyCancelCleanup's own doc comment (chat_checkout.go).
	engine.RegisterActivity("applyCancelCleanup", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCancelCleanupInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return nil, nil
		}
		applyCancelCleanup(ctx, m.chat, m.dataDir, arg)
		publishChatChanged(arg.Repo, arg.PR, arg.ConversationID)
		return nil, nil
	})
	// Activity: the chat_merge queue's own per-request work — attempt the
	// conversation's shadow-worktree push, escalating to an automatic git merge
	// and, only for a real conflict, one begrensde Claude attempt (write: git
	// commit/merge/push guarded by ingestMu around the plumbing that touches the
	// shared clone — see chat_merge.go/chat_shadow.go).
	engine.RegisterActivity("processChatMerge", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatMergeInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.chat == nil {
			return json.Marshal(chat.Message{})
		}
		// clearCheckoutProgress + withCheckoutProgress: same live-progress log
		// the checkout-menu Activities below use — a landing runs real `git`
		// commands (commitCheckoutEditsAt) too. acquireCheckoutWriteSlot: this
		// PR's own checkout write-slot (chat_write_gate.go) — a write turn's own
		// escalated Bash/Edit tools may still be running on this exact checkout
		// (its own turn released the slot before this landing step started, see
		// chat_write_gate.go's own doc comment), so this Activity must wait its
		// turn rather than race it. onWaiting surfaces via the checkout progress
		// log (visible if the overlay happens to be open), the always-visible
		// checkout chip (setCheckoutWaiting, inside acquireCheckoutWriteSlot
		// itself), and, best effort, this conversation's own live chat status
		// line (a no-op if that turn's progress snapshot has already been
		// cleared — true for BOTH the automatic post-turn landing and a manual
		// "commit" request, since neither has a running turn snapshot by the
		// time this Activity runs; kept anyway as a free win for any future
		// caller that does).
		clearCheckoutProgress(arg.Repo, arg.PR)
		ctx = withCheckoutProgress(ctx, arg.Repo, arg.PR)
		release := acquireCheckoutWriteSlot(ctx, m.dataDir, arg.Repo, arg.PR, func() {
			appendCheckoutWaitingStep(arg.Repo, arg.PR)
			advanceChatProgress(arg.Repo, arg.PR, arg.ConversationID, chatPhaseWaiting)
		})
		defer release()
		msg := processChatMerge(ctx, m, m.chat, m.claude, m.dataDir, arg)
		publishChatChanged(arg.Repo, arg.PR, arg.ConversationID)
		return json.Marshal(msg)
	})

	// Activity: push one PR's landed-but-unpushed chat edits to GitHub, from the
	// same per-PR chat_merge queue that serializes landings (write: a real
	// `git push` plus dropping the local pending ref — see pending_push.go).
	engine.RegisterActivity("pushPendingPR", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatMergeInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		pushPendingPR(ctx, m, arg.Repo, arg.PR)
		return nil, nil
	})

	// The four checkout-menu Activities (the chip next to "Live AI assistent"
	// in prInfoCard, src/home.mjs — see chat_checkout.go's "The UI-menu
	// actions" and todo/todo-local-checkout-chat-edits.md). Each publishes
	// checkoutChanged so every open tab watching this PR refetches
	// GET /api/chat/checkout, same "an event is never the source of truth"
	// rule as every other publisher in this file.
	//
	// Each also takes this PR's own checkout write-slot
	// (acquireCheckoutWriteSlot, chat_write_gate.go) before touching git,
	// exactly like a code-editing chat turn does: without it, an overlay
	// answer (e.g. discarding/stashing a "dirty" tree) could run concurrently
	// with an active turn's own Bash/Edit tools on that same checkout.
	// onWaiting appends a worded step to the SAME progress log the overlay
	// already polls (appendCheckoutWaitingStep, checkout_progress.go) and
	// flips the always-visible checkout chip's own "wachten" state
	// (setCheckoutWaiting, inside acquireCheckoutWriteSlot), so a wait here is
	// always a visible word, never a silent stall.
	engine.RegisterActivity("checkoutRelist", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCheckoutActionInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		// clearCheckoutProgress + withCheckoutProgress: every runGitIn call this
		// Activity makes from here on is recorded for the werkmap overlay's live
		// progress panel (checkout_progress.go) — see its own doc comment.
		clearCheckoutProgress(arg.Repo, arg.PR)
		ctx = withCheckoutProgress(ctx, arg.Repo, arg.PR)
		release := acquireCheckoutWriteSlot(ctx, m.dataDir, arg.Repo, arg.PR, func() {
			appendCheckoutWaitingStep(arg.Repo, arg.PR)
		})
		defer release()
		relistCheckoutCandidates(ctx, m, m.dataDir, arg.Repo, arg.PR)
		publishCheckoutChanged(arg.Repo, arg.PR)
		return nil, nil
	})
	engine.RegisterActivity("checkoutAnswer", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCheckoutActionInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		clearCheckoutProgress(arg.Repo, arg.PR)
		ctx = withCheckoutProgress(ctx, arg.Repo, arg.PR)
		release := acquireCheckoutWriteSlot(ctx, m.dataDir, arg.Repo, arg.PR, func() {
			appendCheckoutWaitingStep(arg.Repo, arg.PR)
		})
		defer release()
		// Reuse the exact same resolution path a chat turn's own pending-decision
		// check uses (chat_workflow.go's runOneClaudeTurn) — a menu-driven answer
		// and a chat-driven answer share one code path, one set of rules.
		_, _, _ = prepareChatShellWorkDir(ctx, m, m.dataDir, arg.Repo, arg.PR, arg.Reply)
		publishCheckoutChanged(arg.Repo, arg.PR)
		return nil, nil
	})
	engine.RegisterActivity("checkoutOff", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCheckoutActionInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		clearCheckoutProgress(arg.Repo, arg.PR)
		release := acquireCheckoutWriteSlot(ctx, m.dataDir, arg.Repo, arg.PR, func() {
			appendCheckoutWaitingStep(arg.Repo, arg.PR)
		})
		defer release()
		checkoutSetOff(m.dataDir, arg.Repo, arg.PR)
		publishCheckoutChanged(arg.Repo, arg.PR)
		return nil, nil
	})
	engine.RegisterActivity("checkoutRestoreStash", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatCheckoutActionInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		clearCheckoutProgress(arg.Repo, arg.PR)
		ctx = withCheckoutProgress(ctx, arg.Repo, arg.PR)
		release := acquireCheckoutWriteSlot(ctx, m.dataDir, arg.Repo, arg.PR, func() {
			appendCheckoutWaitingStep(arg.Repo, arg.PR)
		})
		defer release()
		if err := checkoutRestoreStashNow(ctx, m.dataDir, arg.Repo, arg.PR); err != nil {
			m.logf("checkout: restore stash pr %d: %v", arg.PR, err)
		}
		publishCheckoutChanged(arg.Repo, arg.PR)
		return nil, nil
	})

	// The Jira-notification tracker's two Activities (see jira_notifications.go).
	m.registerJiraNotifyActivities(engine)
	// The Jira-issues tracker's one Activity (see jira_issues.go).
	m.registerJiraIssuesActivities(engine)
	m.registerPlanActivities(engine)
	// The one Activity that posts a Jira comment (see jira_comment.go).
	m.registerJiraCommentActivities(engine)
	m.registerPlanExecuteActivities(engine)

	engine.RegisterWorkflow(WorkflowTaskCodeComment, taskCodeCommentWorkflow)
	engine.RegisterWorkflow(WorkflowPRStatus, prStatusWorkflow)
	engine.RegisterWorkflow(WorkflowPRInbox, prInboxWorkflow)
	engine.RegisterWorkflow(WorkflowJiraInbox, jiraInboxWorkflow)
	engine.RegisterWorkflow(WorkflowJiraIssues, jiraIssuesWorkflow)
	engine.RegisterWorkflow(WorkflowPlan, planWorkflow)
	engine.RegisterWorkflow(WorkflowPlanExecute, planExecuteWorkflow)
	engine.RegisterWorkflow(WorkflowJiraComment, jiraCommentWorkflow)
	engine.RegisterWorkflow(WorkflowBuildRelations, buildRelationsWorkflow)
	engine.RegisterWorkflow(WorkflowIngest, ingestWorkflow)
	engine.RegisterWorkflow(WorkflowResolveCall, resolveCallWorkflow)
	engine.RegisterWorkflow(WorkflowResolveTestCovers, resolveTestCoversWorkflow)
	engine.RegisterWorkflow(WorkflowExplainCode, explainCodeWorkflow)
	engine.RegisterWorkflow(WorkflowApprove, approveWorkflow)
	engine.RegisterWorkflow(WorkflowSubmitReview, submitReviewWorkflow)
	engine.RegisterWorkflow(WorkflowReadyForReview, readyForReviewWorkflow)
	engine.RegisterWorkflow(WorkflowRemoveReviewer, removeReviewerWorkflow)
	engine.RegisterWorkflow(WorkflowCodeWarning, codeWarningWorkflow)
	engine.RegisterWorkflow(WorkflowAutoWarn, autoWarnPrefWorkflow)
	engine.RegisterWorkflow(WorkflowAutoIngestPref, autoIngestPrefWorkflow)
	engine.RegisterWorkflow(WorkflowLangPref, langPrefWorkflow)
	engine.RegisterWorkflow(WorkflowAppSettings, appSettingsWorkflow)
	engine.RegisterWorkflow(WorkflowDebugLog, debugLogWorkflow)
	engine.RegisterWorkflow(WorkflowIgnoreRuns, ignoreRunsWorkflow)
	engine.RegisterWorkflow(WorkflowIgnoreComment, ignoreCommentWorkflow)
	engine.RegisterWorkflow(WorkflowCleanup, cleanupWorkflow)
	engine.RegisterWorkflow(WorkflowClaudeChat, claudeChatWorkflow)
	engine.RegisterWorkflow(WorkflowChatMerge, chatMergeQueueWorkflow)
	engine.RegisterWorkflow(WorkflowChatSteer, chatSteerWorkflow)
	engine.RegisterWorkflow(WorkflowCommentBatch, commentBatchWorkflow)
	engine.RegisterWorkflow(WorkflowTestRun, testRunWorkflow)
	engine.RegisterWorkflow(WorkflowSummarizeChat, summarizeChatWorkflow)
	engine.RegisterWorkflow(WorkflowCommentTitles, commentTitlesWorkflow)

	// The LLM-heavy workflows make many/long claude calls (resolve_call runs one
	// claude call per unresolved call in the block; code_warning a whole agentic
	// Opus pass). If the process is killed mid-flight, those uncompleted
	// activities re-execute live on Recover — so recovering them synchronously
	// would block server startup (and the fast, important workflows) for minutes.
	// Mark them PriorityLow so Recover drains them in the background instead. See
	// .claude/docs/tembed-workflows.md ("Recovery priority").
	engine.SetWorkflowPriority(WorkflowResolveCall, tembed.PriorityLow)
	engine.SetWorkflowPriority(WorkflowResolveTestCovers, tembed.PriorityLow)
	engine.SetWorkflowPriority(WorkflowExplainCode, tembed.PriorityLow)
	engine.SetWorkflowPriority(WorkflowSummarizeChat, tembed.PriorityLow)
	engine.SetWorkflowPriority(WorkflowCommentTitles, tembed.PriorityLow)
	engine.SetWorkflowPriority(WorkflowCodeWarning, tembed.PriorityLow)
	// Every claude_chat turn is a real claude subprocess call (see
	// runOneClaudeTurn) — same reasoning as the LLM-heavy workflows above: an
	// interrupted turn must not block server startup on recovery.
	engine.SetWorkflowPriority(WorkflowClaudeChat, tembed.PriorityLow)
	// chat_merge's own processChatMerge Activity can, on a real conflict, run one
	// claude subprocess call (resolveConflictWithClaude) — same reasoning.
	engine.SetWorkflowPriority(WorkflowChatMerge, tembed.PriorityLow)
	// chat_steer only hands a message over (in-memory delivery, or one Signal to
	// the conversation's own run) — no claude call at all — but its fallback
	// Activity blocks for as long as the running turn holds that run's lock, so
	// it must not sit on the startup path either.
	engine.SetWorkflowPriority(WorkflowChatSteer, tembed.PriorityLow)
	// comment_batch's single Activity IS a long agentic run (minutes) — same
	// reasoning, plus this is what makes StartCommentBatch's StartWorkflowDeferLow
	// hand the run off to the background instead of holding the HTTP request.
	engine.SetWorkflowPriority(WorkflowCommentBatch, tembed.PriorityLow)
	// test_run's single Activity IS a long agentic run (minutes) — same
	// reasoning, plus this is what makes StartTestRun's StartWorkflowDeferLow
	// hand the run off to the background instead of holding the HTTP request.
	engine.SetWorkflowPriority(WorkflowTestRun, tembed.PriorityLow)
	// plan_execute's middle Activity IS a long agentic run (minutes) that also
	// pushes and opens a PR — same reasoning, plus this is what makes
	// StartPlanExecute's StartWorkflowDeferLow hand the run off to the
	// background instead of holding the HTTP request.
	engine.SetWorkflowPriority(WorkflowPlanExecute, tembed.PriorityLow)

	// pr_status itself is important (merge/close detection + ingest refresh) and
	// stays Normal — but its one slow LLM step, generatePRSummary (a Haiku call),
	// must not block startup if a pr_status run was killed mid-summary. Marking
	// just that activity PriorityLow defers such a run to the background at
	// exactly that step, without demoting the whole workflow.
	engine.SetActivityPriority("generatePRSummary", tembed.PriorityLow)
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

// SetAppDataDir records the directory settings.json/praise-words.json live
// in — see the appDataDir field's own comment for why this can differ from
// dataDir. Called once from runServe (main.go), which is the only place that
// has both directories at hand.
func (m *TaskManager) SetAppDataDir(dir string) {
	m.appDataDir = dir
}

// appDataDirOrDefault resolves the settings.json/praise-words.json directory
// for the two app_settings Activities: SetAppDataDir's value when set,
// otherwise dataDir — so every existing call site that only ever had one
// dataDir (every non-serve subcommand, and every pre-existing test that
// constructs a TaskManager directly) keeps working unchanged.
func (m *TaskManager) appDataDirOrDefault() string {
	if m.appDataDir != "" {
		return m.appDataDir
	}
	return m.dataDir
}

// ArmReadyGate replaces the (default already-open) ready gate with a closed
// one, so every background poller/trigger that calls waitReady blocks until
// MarkReady is called. newTasks calls this once, only when resumeRuntime is
// true, right before Recover() — see MarkReady/waitReady for why this exists:
// a burst of background work (pollImportComments' immediate first import,
// EnsureInbox's initial fetch, the automatic code_warning
// trigger) must not compete with — and thereby delay — the synchronous work
// Recover/ListenAndServe still have to do at startup.
func (m *TaskManager) ArmReadyGate() {
	m.ready = make(chan struct{})
}

// MarkReady opens the ready gate: every background poller/trigger parked in
// waitReady proceeds. Call this once, right after the HTTP listener has
// actually bound its port (runServe in main.go) — never before, and never
// from inside newTasks, since that call itself must return before the
// listener can bind.
func (m *TaskManager) MarkReady() {
	close(m.ready)
}

// waitReady blocks until MarkReady has been called (a no-op — the gate is
// already open — for every caller that never called ArmReadyGate: tests and
// one-shot CLI processes).
func (m *TaskManager) waitReady() {
	<-m.ready
}

// enqueueAutoStartCodeWarning queues pr for the automatic code_warning trigger
// and lazily starts the single serial worker that drains the queue (see
// runCodeWarnWorker). Called from the autoStartCodeWarning Activity, which
// must itself stay fast/deterministic — this only ever sends on a buffered
// channel or logs and drops on the (practically unreachable) full-queue case.
func (m *TaskManager) enqueueAutoStartCodeWarning(key prKey) {
	m.codeWarnWorkerOne.Do(func() { go m.runCodeWarnWorker() })
	select {
	case m.codeWarnQueue <- key:
	default:
		m.logf("code_warning: auto-start queue full, dropping pr=%s", key)
	}
}

// runCodeWarnWorker drains codeWarnQueue one PR at a time, forever — the
// single serialization point for every automatic code_warning trigger (see
// enqueueAutoStartCodeWarning). It waits for the ready gate first, so a burst
// of triggers queued during startup recovery never starts its (possibly many)
// Opus calls until after the HTTP listener has bound; from then on it simply
// processes whatever is queued, one PR at a time, same "avoid a thundering
// herd" precaution Engine.Recover applies to its own background low-priority
// drain.
func (m *TaskManager) runCodeWarnWorker() {
	m.waitReady()
	for key := range m.codeWarnQueue {
		m.autoStartCodeWarning(key.Repo, key.PR)
	}
}

// ghFor returns the github.Client to use for a canonical repo string: the
// injected one for the primary repo (which is also the Fake under
// SLASH_GITHUB=off, so tests never reach the network), and a lazily created,
// cached per-repo client for any other. Every Activity that talks to GitHub about
// a specific PR goes through this instead of m.gh directly, so a PR from a second
// repo is never posted to / read from the primary repo.
func (m *TaskManager) ghFor(repo string) github.Client {
	if repo == "" || m.gh == nil {
		return m.gh
	}
	if _, isFake := m.gh.(*github.Fake); isFake {
		// Offline/test mode: one Fake stands in for every repo.
		return m.gh
	}
	m.ghMu.Lock()
	defer m.ghMu.Unlock()
	if c, ok := m.ghByRepo[repo]; ok {
		return c
	}
	if m.ghByRepo == nil {
		m.ghByRepo = map[string]github.Client{}
	}
	c := github.New(repoSlugFor(repo))
	m.ghByRepo[repo] = c
	return c
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
	// This top-of-function build runs exactly once, the very first time this
	// PR is ever ingested — real "there are changes" (a brand-new PR). Fire the
	// automatic code_warning trigger here, but NOT from the "rebuild" loop
	// below: a plain re-ingest/"Regenereren" Signal carries no guarantee that
	// any code actually changed, so it must never auto-start an agentic Opus
	// run on its own (see prStatusWorkflow's delta-refresh branch for the
	// other legitimate trigger — genuinely new commits).
	if err := w.ExecuteActivity("autoStartCodeWarning", in, nil); err != nil {
		return nil, fmt.Errorf("auto-start code warning: %w", err)
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
	// A full ingest swaps in an entirely fresh row space for every file of the PR,
	// so every stored comment/approval anchor of a re-ingested PR has to be
	// re-derived against it — exactly like the delta-refresh path does (see
	// reanchor.go). Without this, clicking "Regenereren" after new commits landed
	// broke every anchor of a changed file AND closed the repair window: the
	// ingest records the new SHAs, so the delta poller then reports Skipped and
	// never runs the pass for that delta either.
	//
	// A first ingest has no previous SHAs and nothing stored to move, so the
	// Activity is a cheap no-op there. Deliberately after the blocks are stored:
	// the matcher resolves each anchor against the PR's CURRENT blocks.
	if err := w.ExecuteActivity("reanchorAfterRefresh", map[string]any{
		"pr": in.PR, "prevBaseSHA": res.PrevBaseSHA,
		"prevHeadSHA": res.PrevHeadSHA, "changedFiles": res.ChangedFiles,
	}, nil); err != nil {
		return nil, fmt.Errorf("reanchor after ingest: %w", err)
	}
	return json.Marshal(res)
}

// StartIngest runs the ingest Workflow Execution for pr to completion
// (StartWorkflow drives a signal-less workflow synchronously) and returns its
// result summary. Starting an Execution is the sanctioned write path — this is
// the only way blocks/worktrees are written.
func (m *TaskManager) StartIngest(ctx context.Context, repo string, pr int) (*ingestResult, error) {
	runID, err := m.engine.StartWorkflow(WorkflowIngest, IngestInput{Repo: repo, PR: pr})
	if err != nil {
		return nil, err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return nil, err
	}
	if status == tembed.StatusFailed {
		// Result() on a failed run returns the actual recorded failure (the
		// ActivityFailed/WorkflowFailed error text, e.g. a git fetch's
		// "Permission denied (publickey)") instead of a bare status check, so
		// the reviewer sees the real cause in the /pr-overview popover instead
		// of just a run ID they'd have to look up in the workflow history.
		if resErr := m.engine.Result(runID, nil); resErr != nil {
			return nil, ingestFailureError(runID, resErr)
		}
		return nil, fmt.Errorf("ingest failed (run %s)", runID)
	}
	var res ingestResult
	if err := m.engine.Result(runID, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// ingestFailureError wraps a failed ingest run's real cause (see StartIngest
// above) with a friendly, actionable line on top for a git-auth failure
// (the server process's SSH key can't read the repo) — the raw git/tembed
// text alone ("exit status 128: git@github.com: Permission denied
// (publickey). fatal: Could not read from remote repository. …") reads as
// opaque noise to a reviewer, who can't do anything with a run ID or an SSH
// error either way. The technical detail stays in the message (via %w), it
// doesn't replace it — TestStartIngestSurfacesRealFailure still asserts the
// real cause text is present, and a future debugging session still needs it.
// Every other failure keeps the original "ingest failed (run …): …" text
// unchanged.
func ingestFailureError(runID string, cause error) error {
	if isGitAuthFailure(cause) {
		return fmt.Errorf("We kunnen geen `git pull` draaien. Doe dit handmatig in de terminal en typ je wachtwoord.\n\ningest failed (run %s): %w", runID, cause)
	}
	return fmt.Errorf("ingest failed (run %s): %w", runID, cause)
}

// isGitAuthFailure recognizes the handful of git stderr phrasings a rejected
// SSH key produces (publickey rejected, or the same rejection surfacing as
// "repository not found" because git can't tell "no access" from "doesn't
// exist" for a private repo over SSH).
func isGitAuthFailure(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "Permission denied (publickey)") ||
		strings.Contains(msg, "Could not read from remote repository")
}

// cleanupWorkflow purges all data of merged-and-old PRs, plus any run of a
// permanently retired Workflow Type, plus any task_code_comment run whose own
// comment is gone from comments.db, plus any old-enough test_run leftover
// residue. It is deterministic: the cutoff is read once via w.Now() (recorded
// through SideEffect, so replay reuses the same value) unless the input
// already carries one; all side effects (the github/DB/disk reads in
// resolveCleanupTargets, the worktree/workflow-run/DB removals in purgePR,
// the retired-run deletions in purgeRetiredWorkflows, the orphan-comment-run
// deletions in purgeOrphanCommentRuns, the test_run residue removal in
// sweepTestRunResidue) live in its Activities. The number of purgePR calls is
// exactly len(targets.Targets) — a function of the stored
// resolveCleanupTargets result, so replay-safe; purgeRetiredWorkflows,
// purgeOrphanCommentRuns and sweepTestRunResidue each run exactly once,
// unconditionally. No signals, one Execution per run — mirrors
// ingestWorkflow/submitReviewWorkflow.
func cleanupWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in CleanupInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if in.Cutoff.IsZero() {
		in.Cutoff = w.Now().Add(-cleanupMergedAge)
	}

	var retired struct {
		Deleted int `json:"deleted"`
	}
	if err := w.ExecuteActivity("purgeRetiredWorkflows", nil, &retired); err != nil {
		return nil, fmt.Errorf("purge retired workflow runs: %w", err)
	}

	var orphanComments struct {
		Deleted int `json:"deleted"`
	}
	if err := w.ExecuteActivity("purgeOrphanCommentRuns", nil, &orphanComments); err != nil {
		return nil, fmt.Errorf("purge orphan comment runs: %w", err)
	}

	var testRunResidue struct {
		Swept int `json:"swept"`
	}
	if err := w.ExecuteActivity("sweepTestRunResidue", nil, &testRunResidue); err != nil {
		return nil, fmt.Errorf("sweep test_run residue: %w", err)
	}

	var debugLogRuns struct {
		Deleted int `json:"deleted"`
	}
	if err := w.ExecuteActivity("sweepDebugLogRuns", nil, &debugLogRuns); err != nil {
		return nil, fmt.Errorf("sweep debug_log runs: %w", err)
	}

	var jiraNotifications struct {
		Deleted int `json:"deleted"`
	}
	if err := w.ExecuteActivity("purgeJiraNotifications", in, &jiraNotifications); err != nil {
		return nil, fmt.Errorf("purge jira notifications: %w", err)
	}

	var targets CleanupTargets
	if err := w.ExecuteActivity("resolveCleanupTargets", in, &targets); err != nil {
		return nil, fmt.Errorf("resolve cleanup targets: %w", err)
	}

	res := CleanupResult{
		Cutoff:                   in.Cutoff,
		RetiredRunsDeleted:       retired.Deleted,
		OrphanCommentRunsDeleted: orphanComments.Deleted,
		TestRunResidueSwept:      testRunResidue.Swept,
		DebugLogRunsDeleted:      debugLogRuns.Deleted,
		JiraNotificationsPurged:  jiraNotifications.Deleted,
	}
	for _, t := range targets.Targets {
		var purged CleanupPurgeResult
		if err := w.ExecuteActivity("purgePR", t, &purged); err != nil {
			return nil, fmt.Errorf("purge pr %d: %w", t.PR, err)
		}
		res.Purged = append(res.Purged, purged)
	}
	// LAST, deliberately: appending a step keeps every position above
	// unchanged, so an Execution recorded before this Activity existed replays
	// its whole history and only then finds one more step
	// (.claude/rules/workflow-determinism.md). Unconditional and once per
	// pass, like the sweeps at the top.
	var planArtifacts struct {
		Swept int `json:"swept"`
	}
	if err := w.ExecuteActivity("sweepPlanArtifacts", in, &planArtifacts); err != nil {
		return nil, fmt.Errorf("sweep plan artifacts: %w", err)
	}
	res.PlanArtifactsSwept = planArtifacts.Swept
	return json.Marshal(res)
}

// StartCleanup runs the cleanup Workflow Execution to completion (mirrors
// StartIngest/StartSubmitReview — a signal-less workflow, so StartWorkflow
// drives it synchronously) and returns its result summary. This is the
// sanctioned write path — the only way merged-PR data (worktrees, workflow
// runs, read-model rows) gets removed. Called both by the manual
// POST /api/workflows/cleanup endpoint and the daily scheduler (see
// StartCleanupScheduler in tasks_api.go).
func (m *TaskManager) StartCleanup(ctx context.Context) (*CleanupResult, error) {
	return m.startCleanup(ctx, CleanupInput{})
}

// StartCleanupForce runs the cleanup Workflow Execution with an explicit
// ForcePRs override (see CleanupInput.ForcePRs) — purging each named PR's
// data unconditionally, regardless of what GitHub reports (or whether the PR
// exists on GitHub at all). Used only by the `slash cleanup -force <pr,...>`
// CLI command: deliberately not reachable via POST /api/workflows/cleanup, so
// there is no standing HTTP endpoint that can force-purge an arbitrary PR.
func (m *TaskManager) StartCleanupForce(ctx context.Context, forcePRs []int) (*CleanupResult, error) {
	return m.startCleanup(ctx, CleanupInput{ForcePRs: forcePRs})
}

func (m *TaskManager) startCleanup(ctx context.Context, in CleanupInput) (*CleanupResult, error) {
	runID, err := m.engine.StartWorkflow(WorkflowCleanup, in)
	if err != nil {
		return nil, err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return nil, err
	}
	if status == tembed.StatusFailed {
		return nil, fmt.Errorf("cleanup failed (run %s)", runID)
	}
	var res CleanupResult
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

// rejectSelfReview reports an error when the PR's own author and the
// authenticated gh user (the identity that will actually run `gh api POST
// .../reviews` — deliberately NOT the settings.json "me" override, which is
// only a display/mention-matching convenience, see "Who am I" in
// conventions.md) are the same login. GitHub itself refuses a review
// submission in that case, which used to surface as a bare "exit status 1"
// once it reached gh (see the PR-13535 diagnosis) — this fails fast with a
// readable message instead of ever starting a workflow that can only fail.
//
// Best-effort in the OTHER direction: if the author or the current user
// can't be determined at all (no prmeta row yet, a gh hiccup), the check is
// silently skipped and the request proceeds — this is a UX guard against a
// known-impossible action, not a security boundary, and must never block a
// legitimate review just because a lookup failed.
func (m *TaskManager) rejectSelfReview(ctx context.Context, in SubmitReviewInput) error {
	if m.prmeta == nil {
		return nil
	}
	meta, ok, err := m.prmeta.Get(ctx, in.Repo, in.PR)
	if err != nil || !ok || meta.Author == "" {
		return nil
	}
	me, err := m.CurrentUser(ctx)
	if err != nil || me.Login == "" {
		return nil
	}
	if strings.EqualFold(meta.Author, me.Login) {
		return errSelfReview
	}
	return nil
}

// errSelfReview is rejectSelfReview's sentinel — handleSubmitReview checks it
// with errors.Is to answer with 400 (a client-side, "this can never work"
// request) instead of the 502 it uses for a genuine gh/workflow failure.
var errSelfReview = errors.New("cannot submit a review on your own pull request")

// StartSubmitReview runs the submit_review Workflow Execution for in to
// completion (StartWorkflow drives a signal-less workflow synchronously) and
// returns its Run ID. Starting an Execution is the sanctioned write path —
// this is the only way a real GitHub PR-level review gets submitted. Unlike
// resolve_call/explain_code (best-effort LLM lookups that never fail the
// caller), a failed GitHub submission must reach the caller as an error —
// mirrors StartIngest's status check. rejectSelfReview runs first (a plain
// read, so it needs no workflow of its own) so a doomed self-review never
// even creates a failed Execution.
func (m *TaskManager) StartSubmitReview(ctx context.Context, in SubmitReviewInput) (string, error) {
	if err := m.rejectSelfReview(ctx, in); err != nil {
		return "", err
	}
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

// removeReviewerWorkflow drops the local reviewer from a PR's requested
// reviewers. One Activity, always in the same position, so replay is trivially
// deterministic. No signal — it runs straight through and completes, mirroring
// readyForReviewWorkflow.
func removeReviewerWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in RemoveReviewerInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("removeSelfAsReviewer", in, nil); err != nil {
		return nil, fmt.Errorf("remove reviewer: %w", err)
	}
	return json.Marshal(map[string]any{"pr": in.PR})
}

// StartRemoveReviewer runs the remove_reviewer Workflow Execution to completion
// (a signal-less workflow runs synchronously) and returns its Run ID. Starting
// an Execution is the sanctioned write path; a failed GitHub call reaches the
// caller as an error, mirroring StartReadyForReview.
func (m *TaskManager) StartRemoveReviewer(in RemoveReviewerInput) (string, error) {
	runID, err := m.engine.StartWorkflow(WorkflowRemoveReviewer, in)
	if err != nil {
		return "", err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return runID, err
	}
	if status == tembed.StatusFailed {
		return runID, fmt.Errorf("remove reviewer failed (run %s)", runID)
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

// CurrentUser returns the authenticated GitHub user (the local reviewer), cached
// for the process lifetime. Read-only — the github CurrentUser call mutates
// nothing, so this is safe outside a workflow, and the cache is in-memory only
// (the same operational carve-out as the heartbeat map / the avatar image cache,
// see .claude/rules/workflows-write-boundary.md).
//
// It exists because a comment/reply written in this app carries no GitHub author
// of its own — the UI posts a placeholder ("reviewer") and has no avatar — so
// GET /api/me lets the frontend show who "I" am on those own messages.
func (m *TaskManager) CurrentUser(ctx context.Context) (github.Collaborator, error) {
	m.meMu.Lock()
	if m.meKnown {
		defer m.meMu.Unlock()
		return m.meUser, nil
	}
	m.meMu.Unlock()

	if m.gh == nil {
		return github.Collaborator{}, fmt.Errorf("current user: no github client")
	}
	u, err := m.gh.CurrentUser(ctx)
	if err != nil {
		return github.Collaborator{}, err
	}

	m.meMu.Lock()
	m.meUser, m.meKnown = u, true
	m.meMu.Unlock()
	return u, nil
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

// maxOrphanWarnings is how many UNANCHORED findings (Kind "ai_warning", see
// anchoredWarning in code_warning.go) one review may produce before the whole
// attempt is treated as a bad run and redone once — see codeWarningWorkflow.
//
// Such a finding names a file:line that pins to no block at all, so it lands in
// the PR-comment index without a diff row to sit on. One or two are the intended
// vangnet; a whole batch of them means the model's line numbers were off across
// the board, and the reviewer ends up with a list of findings that point at
// nothing (the reported symptom).
const maxOrphanWarnings = 5

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
	reviewArg := warningReviewArg{
		PR: in.PR, Files: scope.Files, BlockCount: scope.BlockCount, MaxFindings: maxFindings,
		Title: scope.Title, Description: scope.Description, JiraDescription: scope.JiraDescription,
	}
	var toCreate []warningToCreate
	if err := w.ExecuteActivity("runAgenticReview", reviewArg, &toCreate); err != nil {
		return nil, fmt.Errorf("run agentic review: %w", err)
	}

	// Too many findings that anchored to nothing → treat this attempt as a bad
	// run: throw its findings away without creating a single comment, wipe the
	// orphans still stored from earlier runs, and review once more. Exactly ONE
	// retry, and its result is then created unconditionally — orphans included:
	// a second bad batch is still worth showing, and looping on the outcome of
	// an LLM call would be both unbounded and expensive.
	//
	// Deterministic: the count comes from the recorded Activity result, so a
	// replay takes the same branch and finds the same fixed number of
	// Activities in the history.
	//
	// This is also the "a new commit landed" hook. A commit never turns an
	// existing warning into an orphan of its own accord — Kind is fixed at
	// creation and planCommentReanchor skips every Kind != "" comment
	// (reanchor.go) — but it does re-run this workflow via pr_status's
	// autoStartCodeWarning, so the check sits exactly where the orphans are
	// actually born.
	if countOrphanWarnings(toCreate) > maxOrphanWarnings {
		// supersedeFileWarnings above only deletes AI comments whose file is in
		// scope; an orphan naming a file the PR doesn't touch at all (the model
		// misremembering a path) therefore survives every run and piles up. This
		// clears them regardless of file.
		if err := w.ExecuteActivity("purgeOrphanWarnings", map[string]any{"pr": in.PR}, nil); err != nil {
			return nil, fmt.Errorf("purge orphan warnings: %w", err)
		}
		toCreate = nil
		if err := w.ExecuteActivity("runAgenticReview", reviewArg, &toCreate); err != nil {
			return nil, fmt.Errorf("rerun agentic review: %w", err)
		}
	}

	// A finding NEVER retracts the reviewer's approval of the row it anchors
	// to — an AI risk check is a hint to look again, not a verdict that the
	// reviewer never read the code. Mirrors the same decision on the frontend
	// side (placing a comment leaves the approval alone too), see
	// .claude/docs/approval.md.
	for _, item := range toCreate {
		if err := w.ExecuteActivity("createWarningComment", item.Comment, nil); err != nil {
			return nil, fmt.Errorf("create warning comment: %w", err)
		}
	}
	return json.Marshal(map[string]int{"found": len(toCreate)})
}

// warningToCreate is runAgenticReview's per-finding Activity result: the
// comment to create plus the block it anchored to (empty for an unanchored
// PR-wide "ai_warning" finding — see anchoredWarning, code_warning.go).
type warningToCreate struct {
	Comment CodeCommentInput `json:"comment"`
	BlockID string           `json:"blockId"`
}

// countOrphanWarnings counts the findings that anchored to no block at all —
// the PR-wide "ai_warning" kind, see anchoredWarning (code_warning.go).
func countOrphanWarnings(list []warningToCreate) int {
	n := 0
	for _, item := range list {
		if item.Comment.Kind == "ai_warning" {
			n++
		}
	}
	return n
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
		if sig.FullyApproved {
			arg := struct {
				Repo string `json:"repo,omitempty"`
				PR   int    `json:"pr"`
			}{Repo: in.Repo, PR: in.PR}
			if err := w.ExecuteActivity("saveFullyApprovedAt", arg, nil); err != nil {
				return nil, fmt.Errorf("save fully approved at: %w", err)
			}
			continue
		}
		arg := struct {
			Repo    string                `json:"repo,omitempty"`
			PR      int                   `json:"pr"`
			BlockID string                `json:"blockId"`
			Rows    []int                 `json:"rows"`
			Calls   []string              `json:"calls"`
			Anchors []approvals.RowAnchor `json:"anchors"`
		}{PR: in.PR, BlockID: sig.BlockID, Rows: sig.Rows, Calls: sig.Calls, Anchors: sig.Anchors}
		if err := w.ExecuteActivity("saveApproval", arg, nil); err != nil {
			return nil, fmt.Errorf("save approval: %w", err)
		}
	}
}

// autoWarnPrefWorkflow persists the reviewer's on/off preference for the
// automatic code_warning trigger, for one repo. It is deterministic: the only
// side effect (the read-model write) is an Activity, the number of Activities
// is exactly the number of "autowarn" Signals in the history. It never
// completes — a long-lived per-repo tracker.
func autoWarnPrefWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in AutoWarnInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var sig AutoWarnSignal
		w.WaitSignal(SignalAutoWarn, &sig)
		arg := struct {
			Repo    string `json:"repo"`
			Enabled bool   `json:"enabled"`
		}{Repo: in.Repo, Enabled: sig.Enabled}
		if err := w.ExecuteActivity("saveAutoWarnEnabled", arg, nil); err != nil {
			return nil, fmt.Errorf("save auto warn enabled: %w", err)
		}
	}
}

// autoIngestPrefWorkflow persists the reviewer's repo-wide preference for
// automatic review-tree generation, for one repo. Deterministic: the only
// side effect (the read-model write) is an Activity, the number of Activities
// equals the number of "auto_ingest_pref" Signals in the history. It never
// completes — a long-lived per-repo tracker, mould of autoWarnPrefWorkflow.
func autoIngestPrefWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in AutoIngestPrefInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var sig AutoIngestPrefSignal
		w.WaitSignal(SignalAutoIngestPref, &sig)
		arg := struct {
			Repo string `json:"repo"`
			Mode string `json:"mode"`
		}{Repo: in.Repo, Mode: sig.Mode}
		if err := w.ExecuteActivity("saveAutoIngestPrefMode", arg, nil); err != nil {
			return nil, fmt.Errorf("save auto ingest pref mode: %w", err)
		}
	}
}

// langPrefWorkflow persists the reviewer's per-type language preference, for
// one repo. Deterministic: the only side effect (the read-model write) is an
// Activity, and the number of Activities equals the number of "lang_pref"
// Signals in the history. It never completes — a long-lived per-repo tracker,
// mould of autoIngestPrefWorkflow.
func langPrefWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in LangPrefInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var sig LangPrefSignal
		w.WaitSignal(SignalLangPref, &sig)
		arg := struct {
			Repo string `json:"repo"`
			Kind string `json:"kind"`
			Lang string `json:"lang"`
		}{Repo: in.Repo, Kind: sig.Kind, Lang: sig.Lang}
		if err := w.ExecuteActivity("saveLangPref", arg, nil); err != nil {
			return nil, fmt.Errorf("save lang pref: %w", err)
		}
	}
}

// appSettingsWorkflow persists the settings-page edits — the mention-alias
// list, the praise-word list and the Jira-notification filter list — for the whole process (see
// AppSettingsInput: there is no per-repo/per-PR scope here). Deterministic:
// the only side effect is the ONE Activity each Signal's Kind selects, so the
// number and order of Activities is exactly the order Signals arrived in. It
// never completes — a single, global, long-lived tracker, mirroring
// autoWarnPrefWorkflow minus the repo scope.
func appSettingsWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	for {
		var sig AppSettingsSignal
		w.WaitSignal(SignalAppSettings, &sig)
		switch sig.Kind {
		case "aliases":
			if err := w.ExecuteActivity("saveMentionAliases", sig.Aliases, nil); err != nil {
				return nil, fmt.Errorf("save mention aliases: %w", err)
			}
		case "praiseWords":
			if err := w.ExecuteActivity("savePraiseWords", sig.PraiseWords, nil); err != nil {
				return nil, fmt.Errorf("save praise words: %w", err)
			}
		case "notifyFilters":
			// An empty list must reach the Activity as an empty JSON array, not
			// null: it is a real value ("filter nothing"), see notifyfilters.go.
			filters := sig.NotifyFilters
			if filters == nil {
				filters = []string{}
			}
			if err := w.ExecuteActivity("saveNotifyFilters", filters, nil); err != nil {
				return nil, fmt.Errorf("save notify filters: %w", err)
			}
		case "jiraCreds":
			if err := w.ExecuteActivity("saveJiraCredentials", sig.JiraCreds, nil); err != nil {
				return nil, fmt.Errorf("save jira credentials: %w", err)
			}
		}
	}
}

// debugLogWorkflow persists ONE batch of debug-mode events (or clears the
// log). One-shot and deterministic in the strictest sense: exactly one
// Activity, chosen by the input's Kind, which the HTTP handler already
// validated — no signals, no clock, no loop. See WorkflowDebugLog above for
// why this is a one-shot rather than a tracker.
func debugLogWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in DebugLogInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if in.Kind == "clear" {
		if err := w.ExecuteActivity("clearDebugLog", nil, nil); err != nil {
			return nil, fmt.Errorf("clear debug log: %w", err)
		}
		return nil, nil
	}
	if err := w.ExecuteActivity("appendDebugLog", in, nil); err != nil {
		return nil, fmt.Errorf("append debug log: %w", err)
	}
	return nil, nil
}

// ignoreRunsWorkflow permanently deletes the failed runs the reviewer chose
// to ignore. One-shot and deterministic: exactly one Activity per id in
// IgnoreRunsInput.RunIDs, in that order — no signals, no clock, no loop, and
// nothing in the body reads live state. See WorkflowIgnoreRuns for why an
// ignore is a deletion rather than a stored flag.
func ignoreRunsWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in IgnoreRunsInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	var res IgnoreRunsResult
	for _, id := range in.RunIDs {
		var out struct {
			Deleted bool `json:"deleted"`
		}
		arg := struct {
			RunID string `json:"runId"`
		}{RunID: id}
		if err := w.ExecuteActivity("deleteIgnoredRun", arg, &out); err != nil {
			return nil, fmt.Errorf("ignore run %s: %w", id, err)
		}
		if out.Deleted {
			res.Ignored++
		} else {
			res.Skipped++
		}
	}
	return json.Marshal(res)
}

// ignoreCommentWorkflow persists which PR-wide comments the reviewer hid from
// the block index, for one PR. It is deterministic: the only side effect (the
// read-model write) is an Activity, the number of Activities is exactly the
// number of "ignore" Signals in the history, and nothing in the body reads a
// clock or any live state. It never completes — a long-lived per-PR tracker,
// mirroring approveWorkflow.
func ignoreCommentWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in IgnoreCommentInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var sig IgnoreCommentSignal
		w.WaitSignal(SignalIgnore, &sig)
		arg := struct {
			Repo      string `json:"repo,omitempty"`
			PR        int    `json:"pr"`
			CommentID string `json:"commentId"`
			Ignored   bool   `json:"ignored"`
		}{PR: in.PR, CommentID: sig.CommentID, Ignored: sig.Ignored}
		if err := w.ExecuteActivity("saveCommentIgnore", arg, nil); err != nil {
			return nil, fmt.Errorf("save comment ignore: %w", err)
		}
	}
}

// resolveCallWorkflow resolves a caller's Go-unresolved method calls with the
// LLM. It is deterministic: the LLM/worktree work is in a single Activity, run
// once per call to completion. It uses ONLY Haiku (context-only) — no automatic
// Sonnet escalation. The generic Sonnet/agentic machinery in resolve_call.go
// still exists (resolveArg.Model, the agentic prompt branch) but this workflow
// never invokes it; see the "alleen Haiku" decision in
// .claude/docs/tembed-workflows.md.
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

// StartResolveCall starts (or idempotently reuses) a resolve_call Execution for
// the given caller + call keys, under a deterministic Run ID (resolveCallRunID)
// — a repeated request for the same not-yet-searched set is a no-op reuse
// instead of a second LLM call, whether it comes from the UI's own "Zoek"
// trigger or the automatic server-side trigger (autoStartResolveCall, called
// from the buildRelations Activity). Starting an Execution is the sanctioned
// write path.
func (m *TaskManager) StartResolveCall(in ResolveCallInput) (string, error) {
	return m.engine.StartWorkflowID(resolveCallRunID(in), WorkflowResolveCall, in)
}

// autoStartResolveCall is the server-side counterpart of the frontend's
// automatic "Zoek" trigger (startCallSearch, home.mjs): it groups every
// currently unresolved call of pr that hasn't used up maxResolveCallAttempts
// per caller + search generation (groupUnresolvedCalls, using
// resolveCallAttempts' durable per-call history count) and starts a
// resolve_call Execution for each — one per
// goroutine, so a rebuild with several unresolved callers doesn't process
// them one at a time (StartResolveCall/StartWorkflowID runs a resolve_call
// Execution's Activities, including the live claude calls, synchronously on
// the calling goroutine — there is no background-yield path for a live
// start, only Recover() prioritises, see .claude/docs/tembed-workflows.md —
// so a sequential loop here used to make caller N wait for every one of
// callers 1..N-1's FULL LLM pass to finish first, even when caller N itself
// had only one unresolved call). The actual number of concurrent `claude`
// subprocesses this can start stays bounded by resolveCallSemaphore
// (resolve_call.go) regardless of how many goroutines are launched here.
// Called as its own goroutine from the buildRelations Activity, so none of
// this blocks ingest/EnsureRelations/prStatusWorkflow's delta-refresh.
// Best-effort: a failed start is logged, never surfaced — this is a
// convenience trigger, not a required step (the frontend's own trigger still
// covers the gap if this one fails or never ran, e.g. for a PR whose relations
// were only ever refreshed headlessly via `slash relations`).
func (m *TaskManager) autoStartResolveCall(repo string, pr int, calls []callresolve.Entry, blocks []Block) {
	attempts := m.resolveCallAttempts(pr)
	for _, in := range groupUnresolvedCalls(pr, calls, attempts, m.storedCallStatuses(repo, pr), blocks) {
		in := in
		go func() {
			if _, err := m.StartResolveCall(in); err != nil {
				m.logf("resolve_call: auto-search start pr=%d caller=%s: %v", pr, in.CallerID, err)
			}
		}()
	}
}

// storedCallStatuses reads the callresolve read-model's CURRENT status per
// (callerId, callKey) pair for pr — the second half of groupUnresolvedCalls'
// retry rule (see its doc comment): an already-attempted call is only re-asked
// while its stored row is still 'unresolved', i.e. it has no answer left to
// show. A module READ, so it is allowed from anywhere (only writes must go
// through a workflow Activity, see .claude/rules/workflows-write-boundary.md);
// it runs in autoStartResolveCall's own goroutine, after the buildRelations
// Activity's UpsertGo, so it sees this rebuild's freshly merged statuses.
// A read error degrades to an empty map, which makes the retry a no-op —
// the conservative direction: never spend LLM budget on a guess.
func (m *TaskManager) storedCallStatuses(repo string, pr int) map[string]string {
	if m.callresolve == nil {
		return nil
	}
	list, err := m.callresolve.List(context.Background(), repo, pr)
	if err != nil {
		return nil
	}
	stored := make(map[string]string, len(list))
	for _, e := range list {
		stored[e.CallerID+"\x1f"+e.CallKey] = e.Status
	}
	return stored
}

// resolveCallAttempts counts, per (callerId, callKey) pair, HOW OFTEN that pair
// has been submitted to a resolve_call Execution for pr, regardless of those
// Executions' current status — durable, since it reads the workflow event
// history (via engine.Runs()/Input()), not the callresolve read-model's own
// status column. That distinction is load-bearing: a read-model status can be
// rewritten by a rebuild (UpsertGo used to drop an answered 'notfound' back to
// 'unresolved' on every rebuild — narrowed since, see its own doc comment), so
// a snapshot of the DB's status could never tell "already attempted" apart from
// "genuinely new" past the very next rebuild. The history never forgets.
//
// It is a COUNT rather than a bool because groupUnresolvedCalls grants each
// pair one extra retry round (maxResolveCallAttempts, resolve_call.go) and
// needs the pair's generation to build the retry's own Run ID. A pair the
// history has never seen is absent from the map, which reads as 0 — the
// first-pass generation, whose Run ID is byte-identical to what it always was.
// Mirrors RunsForPR's own "decode every run's stored input" pattern.
func (m *TaskManager) resolveCallAttempts(pr int) map[string]int {
	runs, err := m.engine.Runs()
	if err != nil {
		return nil
	}
	attempts := map[string]int{}
	for _, r := range runs {
		if r.Workflow != WorkflowResolveCall {
			continue
		}
		raw, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var in ResolveCallInput
		if json.Unmarshal(raw, &in) != nil || in.PR != pr {
			continue
		}
		for _, c := range in.Calls {
			attempts[in.CallerID+"\x1f"+c]++
		}
	}
	return attempts
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

// summarizeChatWorkflow generates the comment-column edit field's prefill for
// "Comment hiervan maken" on an embedded Claude conversation. Deterministic:
// the LLM call is an Activity, the done/failed decision reads that Activity's
// recorded result (history), and the Activity order/count is fixed — mark
// searching, generate, save. Mirrors explainCodeWorkflow exactly, one
// Activity swapped for the chat-transcript equivalent.
func summarizeChatWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in SummarizeChatInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("markChatSummarySearching", in, nil); err != nil {
		return nil, fmt.Errorf("mark searching: %w", err)
	}
	var gen struct {
		Text string `json:"text"`
	}
	if err := w.ExecuteActivity("generateChatSummary", in, &gen); err != nil {
		return nil, fmt.Errorf("generate summary: %w", err)
	}
	status := chat.SummaryStatusDone
	if gen.Text == "" {
		// Offline (claude.Fake) or a Claude hiccup: record a terminal "failed"
		// status so the frontend stops showing "genereren…" and never
		// re-requests this exact conversation+message-count (the deterministic
		// Run ID already dedups).
		status = chat.SummaryStatusFailed
	}
	if err := w.ExecuteActivity("saveChatSummary", map[string]string{
		"commentId": in.CommentID, "status": status, "text": gen.Text,
	}, nil); err != nil {
		return nil, fmt.Errorf("save summary: %w", err)
	}
	return json.Marshal(map[string]string{"status": status})
}

// StartSummarizeChat launches a summarize_chat Execution under its
// deterministic Run ID (chatSummaryRunID) — StartWorkflowID makes a repeated
// request with no new messages an idempotent no-op reuse, so the UI can fire
// on every "Comment hiervan maken" click without ever duplicating an LLM
// call. msgCount is the caller's own snapshot of the conversation's current
// message count (the frontend already has cc.messages loaded), so this needs
// no read of its own just to compute the Run ID. Starting an Execution is the
// sanctioned UI write path.
func (m *TaskManager) StartSummarizeChat(in SummarizeChatInput, msgCount int) (string, error) {
	return m.engine.StartWorkflowID(chatSummaryRunID(in.CommentID, msgCount), WorkflowSummarizeChat, in)
}

// commentTitlesWorkflow gives a batch of review comments a short Dutch title
// (see comment_titles.go). Deterministic: the LLM call is a single Activity,
// the per-comment done/failed decision reads that Activity's recorded result
// (history), the batch is sorted by id before anything iterates it, and the
// Activity order/count is fixed — mark searching, generate, save. Mirrors
// summarizeChatWorkflow, one call for a whole batch instead of one thing.
func commentTitlesWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in CommentTitlesInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	items := sortCommentTitleRefs(in.Items)
	if len(items) == 0 {
		return json.Marshal(map[string]int{"titled": 0})
	}
	if err := w.ExecuteActivity("markCommentTitlesSearching", in, nil); err != nil {
		return nil, fmt.Errorf("mark searching: %w", err)
	}
	var gen struct {
		Titles  map[string]string `json:"titles"`
		BodyLen map[string]int    `json:"bodyLen"`
	}
	if err := w.ExecuteActivity("generateCommentTitles", in, &gen); err != nil {
		return nil, fmt.Errorf("generate titles: %w", err)
	}
	// Built by walking the SORTED batch, never gen.Titles' own map order (a map
	// range would make the history order depend on Go's randomized iteration —
	// see .claude/rules/workflow-determinism.md).
	results := make([]comments.TitleResult, 0, len(items))
	titled := 0
	for _, it := range items {
		bodyLen, ok := gen.BodyLen[it.ID]
		if !ok {
			// The comment disappeared before it could be titled (deleted mid
			// run): no row left to write, so nothing to record either.
			continue
		}
		r := comments.TitleResult{ID: it.ID, BodyLen: bodyLen, Status: comments.TitleStatusFailed}
		if t := gen.Titles[it.ID]; t != "" {
			// Offline (claude.Fake) or a Claude hiccup leaves this empty, which
			// records a terminal "failed" status so the frontend never
			// re-requests this exact comment+body (the deterministic Run ID
			// already dedups).
			r.Title, r.Status = t, comments.TitleStatusDone
			titled++
		}
		results = append(results, r)
	}
	if err := w.ExecuteActivity("saveCommentTitles", map[string]any{"results": results}, nil); err != nil {
		return nil, fmt.Errorf("save titles: %w", err)
	}
	return json.Marshal(map[string]int{"titled": titled})
}

// StartCommentTitles launches a comment_titles Execution under its
// deterministic Run ID (commentTitlesRunID) — StartWorkflowID makes a repeated
// request for the same set of comments an idempotent no-op reuse, so the UI can
// fire on every comment poll without duplicating an LLM call. The batch is
// capped at maxCommentTitleBatch here (after sorting, so which comments make
// the cut is itself deterministic); whatever is left over rides along on the
// next request, whose untitled set — and therefore Run ID — differs. Starting
// an Execution is the sanctioned UI write path.
func (m *TaskManager) StartCommentTitles(in CommentTitlesInput) (string, error) {
	in.Items = sortCommentTitleRefs(in.Items)
	if len(in.Items) > maxCommentTitleBatch {
		in.Items = in.Items[:maxCommentTitleBatch]
	}
	if len(in.Items) == 0 {
		return "", fmt.Errorf("comment_titles: no comments given")
	}
	return m.engine.StartWorkflowID(commentTitlesRunID(in.PR, in.Items), WorkflowCommentTitles, in)
}

// resolveTestCoversWorkflow resolves a test's class-level-only coverage
// annotations (#[CoversClass]/bare "@covers Class") with the LLM — never for a
// test with no annotation at all (that never reaches this workflow). It is
// deterministic: the LLM/worktree work is in a single Activity, run once per
// class to completion. It uses ONLY Haiku (context-only) — no automatic Sonnet
// escalation. The generic Sonnet/agentic machinery in resolve_test_covers.go
// still exists but this workflow never invokes it; see the "alleen Haiku"
// decision in .claude/docs/tembed-workflows.md.
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

// StartResolveTestCovers starts (or idempotently reuses) a resolve_test_covers
// Execution for the given test + class names, under a deterministic Run ID
// (resolveTestCoversRunID) — a repeated request for the same not-yet-searched
// set is a no-op reuse instead of a second LLM call, whether it comes from the
// frontend's own automatic trigger (startTestCoverSearch, home.mjs) or the
// automatic server-side trigger (autoStartResolveTestCovers, called from the
// buildRelations Activity) — mirrors StartResolveCall. Starting an Execution
// is the sanctioned write path.
func (m *TaskManager) StartResolveTestCovers(in ResolveTestCoversInput) (string, error) {
	return m.engine.StartWorkflowID(resolveTestCoversRunID(in), WorkflowResolveTestCovers, in)
}

// autoStartResolveTestCovers is the server-side counterpart of the frontend's
// automatic test-coverage search trigger (startTestCoverSearch, home.mjs): it
// groups every currently unresolved-and-never-yet-attempted class-level-only
// coverage target of pr per test (groupUnresolvedTestCovers, using
// resolveTestCoversAttempted's durable "ever submitted" set) and starts a
// resolve_test_covers Execution for each. Called as its own goroutine from the
// buildRelations Activity, mirroring autoStartResolveCall, so it never blocks
// ingest/EnsureRelations/prStatusWorkflow's delta-refresh on a live claude
// call. Best-effort: a failed start is logged, never surfaced — the
// frontend's own trigger still covers the gap if this one fails or never ran.
func (m *TaskManager) autoStartResolveTestCovers(pr int, covers []testcovers.Entry, blocks []Block) {
	attempted := m.resolveTestCoversAttempted(pr)
	for _, in := range groupUnresolvedTestCovers(pr, covers, attempted, blocks) {
		if _, err := m.StartResolveTestCovers(in); err != nil {
			m.logf("resolve_test_covers: auto-search start pr=%d test=%s: %v", pr, in.TestID, err)
		}
	}
}

// resolveTestCoversAttempted returns every (testId, shortClassName) pair that
// has EVER been submitted to a resolve_test_covers Execution for pr —
// durable, since it reads the workflow event history (via
// engine.Runs()/Input()), not the testcovers read-model's own status column.
// Mirrors resolveCallAttempted; see groupUnresolvedTestCovers for why the
// distinction matters.
func (m *TaskManager) resolveTestCoversAttempted(pr int) map[string]bool {
	runs, err := m.engine.Runs()
	if err != nil {
		return nil
	}
	attempted := map[string]bool{}
	for _, r := range runs {
		if r.Workflow != WorkflowResolveTestCovers {
			continue
		}
		raw, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var in ResolveTestCoversInput
		if json.Unmarshal(raw, &in) != nil || in.PR != pr {
			continue
		}
		for _, c := range in.Classes {
			attempted[in.TestID+"\x1f"+shortName(c)] = true
		}
	}
	return attempted
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
	// Stage 4 runs after the statuses because it reads the "since" moment that
	// stage stored (SaveSinceMark) — it has no way to know it on its own.
	if err := w.ExecuteActivity("generateSinceReviewSummary", in, nil); err != nil {
		return nil, fmt.Errorf("generate since review summary: %w", err)
	}
	for {
		var s PRStateSignal
		w.WaitSignal(SignalPRState, &s)
		if s.State == "merged" || s.State == "closed" {
			return json.Marshal(map[string]any{"pr": in.PR, "state": s.State})
		}
		// Re-derive "what changed since MY last review" (the review tree's sky
		// block). Its own branch, deliberately not folded into the HeadSHA
		// branch below: tembed matches an activity against history purely by
		// POSITION (nthOf(actIdx), no name check), so adding activities to a
		// branch an existing Execution already took would silently misalign
		// every later step of that history. A branch no past signal could take
		// (refreshSince was absent, so false) replays as the empty branch it
		// always was. Stage 3 first — stage 4 reads the "since" moment it
		// stores, exactly as at Execution start.
		if s.RefreshSince {
			if err := w.ExecuteActivity("fetchPRStatuses", in, nil); err != nil {
				return nil, fmt.Errorf("refresh pr statuses: %w", err)
			}
			if err := w.ExecuteActivity("generateSinceReviewSummary", in, nil); err != nil {
				return nil, fmt.Errorf("refresh since review summary: %w", err)
			}
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
				PR          int      `json:"pr"`
				BaseSHA     string   `json:"baseSHA"`
				HeadSHA     string   `json:"headSHA"`
				LandedFiles []string `json:"landedFiles,omitempty"`
			}{PR: in.PR, BaseSHA: s.BaseSHA, HeadSHA: s.HeadSHA, LandedFiles: s.LandedFiles}
			if err := w.ExecuteActivity("refreshIngestDelta", arg, &res); err != nil {
				return nil, fmt.Errorf("refresh ingest delta: %w", err)
			}
			if !res.Skipped {
				// Move the stored comment/approval anchors of the re-scanned files
				// onto their new rows before anything else looks at them: those
				// anchors are row indices into a row space this refresh just
				// rewrote, so until this runs they point at whatever code took
				// their place (see reanchor.go). Covers the full-fallback path too
				// — ChangedFiles is then every path of the PR.
				if err := w.ExecuteActivity("reanchorAfterRefresh", map[string]any{
					"pr": in.PR, "prevBaseSHA": res.PrevBaseSHA,
					"prevHeadSHA": res.PrevHeadSHA, "changedFiles": res.ChangedFiles,
				}, nil); err != nil {
					return nil, fmt.Errorf("reanchor after refresh: %w", err)
				}
				if err := w.ExecuteActivity("buildRelations", BuildRelationsInput{PR: in.PR}, nil); err != nil {
					return nil, fmt.Errorf("rebuild relations after refresh: %w", err)
				}
				// Real new commits landed (this branch only runs when
				// refreshIngestDelta found a new head SHA and res.Skipped is
				// false) — exactly the "there are changes" signal the automatic
				// code_warning trigger should fire on. Mirrors the one-time call
				// in buildRelationsWorkflow for a PR's very first ingest.
				if err := w.ExecuteActivity("autoStartCodeWarning", BuildRelationsInput{PR: in.PR}, nil); err != nil {
					return nil, fmt.Errorf("auto-start code warning after refresh: %w", err)
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

// maxSinceFactLines caps the commit list in sinceReviewFacts and the file list
// in sinceReviewPrompt: the block sits inside the PR-info column, not on a page
// of its own, and a reviewer who has been away for 40 commits is served by
// "en 32 meer" plus the AI explanation above it, not by 40 bullet lines.
const maxSinceFactLines = 8

// sinceReviewFacts renders the deterministic half of the "sinds jouw laatste
// review" block: the commits that landed since, newest first — the most recent
// change is the one a returning reviewer cares about — as a Markdown list.
// That order is load-bearing for the Haiku prompt below: prompts/since_review.md
// asks for the TOP commit only ("wat er als laatst is aangepast"), with the rest
// as context.
//
// The `**…**` heading line is what the UI splits this blob on to give each list
// its own navigable block in the PR-info column (sinceReviewSections,
// home.mjs) — that split scans for the bold heading, not for any Dutch word, so
// rewording a heading here is safe; dropping the `**…**` shape is not.
//
// The touched-file list is deliberately NOT part of this: it was a block of its
// own in the column and the reviewer had it removed ("het 211 bestanden
// geraakt-blok mag weg") — a 200-file list said nothing a returning reviewer
// could act on. It is still handed to the AI, which is what sinceReviewPrompt
// is for, so the explanation keeps that context without the column showing it.
func sinceReviewFacts(commits []github.SinceCommit) string {
	var b strings.Builder
	fmt.Fprintf(&b, "**%s** sinds jouw laatste review:\n\n", plural(len(commits), "nieuwe commit", "nieuwe commits"))
	for i := len(commits) - 1; i >= 0; i-- {
		if shown := len(commits) - 1 - i; shown >= maxSinceFactLines {
			fmt.Fprintf(&b, "- en %d meer\n", i+1)
			break
		}
		c := commits[i]
		line := "- " + c.Headline
		if c.Author != "" {
			line += " (" + c.Author + ")"
		}
		fmt.Fprintln(&b, line)
	}
	return b.String()
}

// sinceReviewPrompt is what the Haiku explanation is asked about: the very same
// facts the UI renders (so the AI never asserts anything the reviewer can't
// check right below it) PLUS the files those commits touched, which the column
// itself no longer shows. The files are context for naming the change, never a
// claim of their own.
func sinceReviewPrompt(facts string, files []string) string {
	if len(files) == 0 {
		return facts
	}
	var b strings.Builder
	b.WriteString(facts)
	fmt.Fprintf(&b, "\n**%s** geraakt:\n\n", plural(len(files), "bestand", "bestanden"))
	for i, f := range files {
		if i >= maxSinceFactLines {
			fmt.Fprintf(&b, "- en %d meer\n", len(files)-i)
			break
		}
		fmt.Fprintf(&b, "- `%s`\n", f)
	}
	return b.String()
}

// plural renders "1 commit" / "3 commits" — the count always leads, so the
// number is readable even when the words wrap.
func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
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

// aiQuoteBody renders an automated finding's own text as an attributed
// Markdown blockquote, so a reader on GitHub can tell at a glance that the
// wording is the AI check's and not the reviewer's. Every line is quoted (a
// blank line included, so a multi-paragraph finding stays one block) and the
// first one carries the marker.
func aiQuoteBody(body string) string {
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	for i, l := range lines {
		if i == 0 {
			lines[i] = "> [AI-check] " + l
			continue
		}
		lines[i] = "> " + l
	}
	return strings.Join(lines, "\n")
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
		Author: in.Author, AvatarURL: in.AvatarURL, Body: in.Body, CreatedAt: in.CreatedAt,
		Code: in.Code, Gran: in.Gran, Label: in.Label,
		RowStart: in.RowStart, RowEnd: in.RowEnd, Seg: in.Seg,
		Path: commentPath(in, runID), Source: in.Source, Kind: in.Kind,
		BlockWide: in.BlockWide,
	}
	if err := w.ExecuteActivity("saveComment", comment, nil); err != nil {
		return nil, fmt.Errorf("save comment: %w", err)
	}
	// Decide the GitHub root comment ID this thread mirrors to, without ever
	// posting twice. Four input-driven (so replay-deterministic) cases:
	//   - Imported (ImportedRootID != 0): the comment already exists on GitHub —
	//     skip posting but record its known RootID, so the poller runs and UI
	//     replies still mirror to the real thread.
	//   - Local (private note): never touches GitHub — RootID stays 0, disabling
	//     the poller and every reply/delete mirror via the existing RootID == 0 guard.
	//   - PR-wide, freshly created (isPRWide(in.Kind), not imported, not local —
	//     e.g. convertPrWideWarningToComment turning an unanchored code_warning
	//     finding into a real comment, RelatedPanel.mjs): a PR-wide comment has
	//     no reply thread on GitHub and, unlike a review-diff comment, no
	//     file:line that's guaranteed to still sit on a line the current diff
	//     covers — postGithubComment would often simply fail for it. Post it
	//     instead as a new, top-level issue comment on the flat PR conversation
	//     (postGithubIssueComment, the SAME best-effort Activity the reactions
	//     loop's own isPRWide branch already uses to mirror a REPLY on such a
	//     thread below) — it never returns an error itself (see its own doc
	//     comment), so a GitHub hiccup here can't abort comment creation.
	//   - Normal (a block-scoped comment): post it as a review comment and
	//     record the new RootID.
	var posted postResult
	switch {
	case in.ImportedRootID != 0:
		posted.RootID = in.ImportedRootID
	case in.Local:
		// no GitHub post
	case isPRWide(in.Kind):
		if err := w.ExecuteActivity("postGithubIssueComment", map[string]any{
			"pr": in.PR, "body": in.Body,
		}, &posted); err != nil {
			return nil, fmt.Errorf("post github issue comment: %w", err)
		}
	default:
		if err := w.ExecuteActivity("postGithubComment", in, &posted); err != nil {
			return nil, fmt.Errorf("post github comment: %w", err)
		}
	}
	// Persist the now-known GitHub id into the comments read-model (a no-op for
	// 0 — a local note, or a post that didn't happen/failed) so the frontend
	// can build a "view on GitHub" deep link without depending on the runID's
	// "gh-<id>" shape (only true for an imported comment, see importedRunID).
	// This ALWAYS runs (its own Activity, unconditionally) so the number of
	// ExecuteActivity calls stays a fixed function of the input shape, not of
	// posted.RootID's value — replay-deterministic; SetGithubID itself is the
	// one that no-ops on 0.
	if err := w.ExecuteActivity("saveCommentGithubID", map[string]any{
		"id": runID, "githubId": posted.RootID,
	}, nil); err != nil {
		return nil, fmt.Errorf("save comment github id: %w", err)
	}

	// Reactions loop: each "reply" Signal (UI or GitHub) is stored, mirrored to
	// the other side, and closes the thread when Done. A "delete" Action instead
	// removes the comment — first flipping its status to "deleting", then
	// deleting it on GitHub (best-effort) and from our own store — and completes
	// the execution, ending the thread.
	reactions := 0
	// replyGithubIDs remembers, per reply ID, the GitHub comment id that reply
	// was mirrored to (0/absent = never mirrored, e.g. a private note or a
	// GitHub-sourced reply that is never echoed back) — so a later "edit" Action
	// on that same reply knows what to PATCH. Rebuilt identically on every
	// replay: it is only ever populated from the recorded result of this same
	// loop's own mirror Activities below, never from live state.
	replyGithubIDs := map[string]int64{}
	// rootPublished says whether the COMMENT'S OWN BODY is what lives at
	// posted.RootID on GitHub. True for an imported or normally posted root,
	// false for a local one — and it stays false when a later Publish "reply"
	// puts the reviewer's REPLY text at posted.RootID instead (see
	// publishThread), so an "edit" of the local root body never PATCHes the
	// GitHub comment that actually holds that reply.
	rootPublished := posted.RootID != 0
	// localReplies remembers the reviewer's own replies written while the thread
	// was still local (posted.RootID == 0), in order — the material a later
	// Publish with PublishHistory brings along. Rebuilt identically on replay:
	// only ever appended from this loop's own signals, and cleared once
	// published. A slice, not a map: the mirror order must be deterministic.
	type localReply struct{ ID, Body string }
	var localReplies []localReply

	// publishThread promotes a thread that has never touched GitHub into a real
	// GitHub thread: it posts `rootBody` as the thread's root (an issue comment
	// for a PR-wide thread, a review comment otherwise — the same two
	// best-effort Activities the initial post uses), records the resulting id on
	// the comment so the read-model flips to "this is a GitHub chat now"
	// (github_id != 0, what the UI reads), and optionally mirrors the earlier
	// local replies onto it. Deterministic: it only ever reads the workflow
	// input and values recorded by this same loop.
	publishThread := func(rootBody string, rootIsOwnBody, history bool) error {
		var pr postResult
		if isPRWide(in.Kind) {
			if err := w.ExecuteActivity("postGithubIssueComment", map[string]any{
				"pr": in.PR, "body": rootBody,
			}, &pr); err != nil {
				return err
			}
		} else {
			rooted := in
			rooted.Body = rootBody
			if err := w.ExecuteActivity("postGithubComment", rooted, &pr); err != nil {
				return err
			}
		}
		posted.RootID = pr.RootID
		rootPublished = rootIsOwnBody && pr.RootID != 0
		if err := w.ExecuteActivity("saveCommentGithubID", map[string]any{
			"id": runID, "githubId": pr.RootID,
		}, nil); err != nil {
			return err
		}
		if history {
			for _, lr := range localReplies {
				var mirrored postResult
				if isPRWide(in.Kind) {
					_ = w.ExecuteActivity("postGithubIssueComment", map[string]any{
						"pr": in.PR, "body": lr.Body,
					}, &mirrored)
				} else {
					_ = w.ExecuteActivity("replyGithub", map[string]any{
						"pr": in.PR, "rootId": posted.RootID, "body": lr.Body,
					}, &mirrored)
				}
				if mirrored.RootID != 0 {
					replyGithubIDs[lr.ID] = mirrored.RootID
					_ = w.ExecuteActivity("saveReactionGithubID", map[string]any{
						"id": lr.ID, "githubId": mirrored.RootID,
					}, nil)
				}
			}
		}
		localReplies = nil
		return nil
	}

	// publishRootBody is the text a Publish posts as the thread's root: the
	// comment's own body, quoted with an attribution marker when it is an
	// automated finding (Source "ai") — a PR reader must never mistake the
	// AI check's wording for the reviewer's own.
	publishRootBody := func() string {
		if in.Source == "ai" {
			return aiQuoteBody(in.Body)
		}
		return in.Body
	}

	for {
		var r ReactionSignal
		w.WaitSignal(SignalReply, &r)

		// An "avatar" action is a pure metadata backfill: it records the ROOT
		// comment's own GitHub avatar URL (see importPRComments) and stores no
		// reply, so the thread itself is untouched. Input-driven like every other
		// branch here, so the Activity sequence stays replay-deterministic.
		if r.Action == "avatar" {
			if err := w.ExecuteActivity("saveCommentAvatar", map[string]any{
				"id": runID, "avatarUrl": r.AvatarURL,
			}, nil); err != nil {
				return nil, fmt.Errorf("save comment avatar: %w", err)
			}
			continue
		}

		// A "reanchor" action is likewise pure metadata: a new commit moved (or
		// dissolved) the code this comment hangs on, so its row anchor is
		// re-derived and written here. Stores no reply, leaves the body and the
		// stored code snippet alone. Input-driven, so replay-deterministic.
		if r.Action == "reanchor" && r.Anchor != nil {
			a := *r.Anchor
			// The path's codeRef segment encodes the same rows, so rebuild it from
			// the moved anchor — reusing commentPath rather than patching the string,
			// so the two can't drift apart. Everything else (pr/file/label) is
			// unchanged, hence a copy of the original input.
			moved := in
			moved.RowStart, moved.RowEnd, moved.Seg, moved.Gran = a.RowStart, a.RowEnd, a.Seg, a.Gran
			if err := w.ExecuteActivity("saveCommentAnchor", map[string]any{
				"id": runID, "rowStart": a.RowStart, "rowEnd": a.RowEnd,
				"seg": a.Seg, "gran": a.Gran, "anchorState": a.AnchorState,
				"path": commentPath(moved, runID),
			}, nil); err != nil {
				return nil, fmt.Errorf("save comment anchor: %w", err)
			}
			continue
		}

		// A "chat" action starts (or idempotently re-ensures) this thread's own
		// embedded Claude conversation as a CHILD workflow of this Execution — the
		// conversation belongs to the comment, so the run tree should say so
		// (RunRecord.ParentRunID). Its run ID stays the derived
		// chatConversationRunID(runID) via ExecuteChildWorkflowID, so everything
		// addressing "chat-<commentID>" (the UI's message Signal, chat_merge.go,
		// cleanup.go) keeps working, and a second "chat" signal is a no-op reuse
		// rather than a second child. Deliberately no WaitChildWorkflow: a
		// claude_chat Execution never completes, so this thread must not block on
		// it. Stores no reply, so the thread itself is untouched. Input-driven like
		// every other branch here, hence replay-deterministic.
		//
		// NOTE for whoever extends claude_chat: this child is started INLINE inside
		// this run's own advance (the parent's run lock is held and is not
		// reentrant), so claude_chat's first Activity must never signal this
		// thread. It only ensures its conversation row and then waits.
		if r.Action == "chat" {
			if _, err := w.ExecuteChildWorkflowID(chatConversationRunID(runID), WorkflowClaudeChat, ClaudeChatInput{
				PR: in.PR, CommentID: runID,
			}); err != nil {
				return nil, fmt.Errorf("start claude chat child: %w", err)
			}
			continue
		}

		// A "publish" action moves the EXISTING conversation to GitHub without
		// adding anything to it: the root's own body (an "ai" one quoted, see
		// publishRootBody) plus, with PublishHistory, the earlier local replies.
		// Stores no reply, so the thread itself is untouched. A no-op once the
		// thread already has a GitHub root — from then on everything mirrors
		// anyway. Input-driven, so replay-deterministic.
		if r.Action == "publish" {
			if posted.RootID == 0 {
				if err := publishThread(publishRootBody(), true, r.PublishHistory); err != nil {
					return nil, fmt.Errorf("publish thread: %w", err)
				}
			}
			continue
		}

		// An "unresolve" action reopens a resolved thread — the mirror image of a
		// resolve (r.Done below), and the reason a resolve no longer ends this
		// Execution. Three steps: the read-model goes back to "open" (which also
		// restarts this thread's GitHub poller, see the reopenComment Activity), a
		// visible trace is stored in the conversation (the reopenSentinel body,
		// rendered as a status line rather than as literal text — see
		// threadStatusSentinel in RelatedPanel.mjs), and a review-diff thread is
		// unresolved on GitHub too. That trace is deliberately LOCAL-only: it is
		// never mirrored to GitHub (this branch continues before the mirror path
		// below), because GitHub's own thread state already says it.
		// Input-driven, so replay-deterministic.
		if r.Action == "unresolve" {
			if err := w.ExecuteActivity("reopenComment", map[string]any{
				"id": runID, "pr": in.PR, "rootId": posted.RootID,
			}, nil); err != nil {
				return nil, fmt.Errorf("reopen comment: %w", err)
			}
			if err := executeActivityWithLockRetry(w, "saveReaction", comments.Reaction{
				ID: r.ID, CommentID: runID, Source: r.Source, Author: r.Author,
				AvatarURL: r.AvatarURL, Body: reopenSentinel,
			}, nil); err != nil {
				return nil, fmt.Errorf("save reopen reaction: %w", err)
			}
			if !isPRWide(in.Kind) && posted.RootID != 0 {
				_ = w.ExecuteActivity("unresolveGithubThread", map[string]any{
					"pr": in.PR, "rootId": posted.RootID,
				}, nil)
			}
			continue
		}

		// An "edit" action changes the wording of an already-placed message the
		// reviewer wrote themselves — either the thread's own root comment
		// (r.ID == runID) or one of its replies (r.ID names that reply's own
		// reaction id, reused here as the edit target rather than adding a
		// second field to ReactionSignal). Stores no NEW reply; only the body of
		// the existing row changes. Mirrored to GitHub (best-effort, like every
		// other GitHub call in this loop) when that row was posted there:
		// isPRWide(in.Kind) means it mirrors as a plain issue comment (both the
		// root of a PR-wide thread and any of its replies always do, per the
		// mirror rule below), otherwise as a review comment (the root of a
		// review-diff thread, or one of its replies — GitHub represents a
		// review-comment reply as a review comment too). Input-driven, so
		// replay-deterministic: which Activities run depends only on r.ID/
		// in.Kind/the already-known posted.RootID / replyGithubIDs, never on a
		// fresh GitHub lookup.
		if r.Action == "edit" {
			if r.ID == runID {
				if err := w.ExecuteActivity("editCommentBody", map[string]any{
					"id": runID, "body": r.Body,
				}, nil); err != nil {
					return nil, fmt.Errorf("edit comment body: %w", err)
				}
				// rootPublished, not just a non-zero RootID: after a Publish
				// "reply" the GitHub comment at posted.RootID holds the
				// reviewer's REPLY, not this body — PATCHing it would rewrite
				// the wrong message (see rootPublished/publishThread).
				if posted.RootID != 0 && rootPublished {
					if isPRWide(in.Kind) {
						_ = w.ExecuteActivity("editGithubIssueComment", map[string]any{
							"commentId": posted.RootID, "body": r.Body,
						}, nil)
					} else {
						_ = w.ExecuteActivity("editGithubReviewComment", map[string]any{
							"commentId": posted.RootID, "body": r.Body,
						}, nil)
					}
				}
			} else {
				if err := w.ExecuteActivity("editReactionBody", map[string]any{
					"id": r.ID, "body": r.Body,
				}, nil); err != nil {
					return nil, fmt.Errorf("edit reaction body: %w", err)
				}
				if ghID := replyGithubIDs[r.ID]; ghID != 0 {
					if isPRWide(in.Kind) {
						_ = w.ExecuteActivity("editGithubIssueComment", map[string]any{
							"commentId": ghID, "body": r.Body,
						}, nil)
					} else {
						_ = w.ExecuteActivity("editGithubReviewComment", map[string]any{
							"commentId": ghID, "body": r.Body,
						}, nil)
					}
				}
			}
			continue
		}

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
			// The reviewer threw an AI risk finding away, so the next
			// code_warning run must not raise it again (modules/warndismiss).
			// r.Source == "ai" means this delete came from
			// supersedeFileWarnings itself — the check replacing its own
			// previous findings, not a reviewer judging one — and must never
			// count as a dismissal. Input-driven, so replay-deterministic, and
			// deliberately the LAST step of this branch: the Execution
			// completes right after, so an already-deleted thread (whose run is
			// completed and never replayed) can't be shifted by it.
			if in.Source == "ai" && r.Source != "ai" {
				if err := w.ExecuteActivity("recordWarningDismissed", map[string]any{
					"pr": in.PR, "file": in.File, "body": in.Body,
				}, nil); err != nil {
					return nil, fmt.Errorf("record dismissed warning: %w", err)
				}
			}
			return json.Marshal(map[string]any{"comment": runID, "deleted": true, "reactions": reactions})
		}

		// A "github" reply can be an ECHO of our own reply: the per-thread
		// poller (poll(), TaskManager) fetches EVERY reply on the GitHub
		// thread, including the one this workflow itself just mirrored out via
		// replyGithub/postGithubIssueComment below — it comes back under a
		// different reaction id ("gh-<githubId>" vs the original "ui-<id>"),
		// so AddReaction's id-based INSERT OR IGNORE never catches it and the
		// reviewer's own reply used to show up twice. replyGithubIDs already
		// records, per own reply id, the GitHub id it was mirrored to — purely
		// rebuilt from this workflow's own history on replay (same mechanism
		// the "edit" action above relies on), so this stays deterministic and
		// needs no fresh lookup. Iteration order doesn't affect the outcome
		// (a membership test), so ranging over the map is safe here.
		if r.Source == "github" {
			echo := false
			for _, ghID := range replyGithubIDs {
				if r.ID == fmt.Sprintf("gh-%d", ghID) {
					echo = true
					break
				}
			}
			if echo {
				continue
			}
		}

		reactions++
		if err := executeActivityWithLockRetry(w, "saveReaction", comments.Reaction{
			ID: r.ID, CommentID: runID, Source: r.Source, Author: r.Author, AvatarURL: r.AvatarURL,
			Body: r.Body, Resolves: r.Done,
		}, nil); err != nil {
			return nil, fmt.Errorf("save reaction: %w", err)
		}

		// Publish: this reply promotes a thread that has never touched GitHub
		// (a private note, or an "ai" finding) into a real one — the reviewer
		// picked that from the send menu (see the replyPublish menu in
		// home.mjs). "reply" makes THIS reply the GitHub root (the local root's
		// body stays private, so it must not be mirrored again below —
		// publishedAsRoot); "thread" posts the root's own body first and lets
		// the ordinary mirror below hang this reply off it. Input-driven, so
		// replay-deterministic. Never for a resolve, and never once the thread
		// already has a GitHub root: from then on every reply mirrors anyway.
		publishedAsRoot := false
		if r.Source == "ui" && !r.Done && posted.RootID == 0 && r.Publish != "" {
			rootBody := publishRootBody()
			if r.Publish == "reply" {
				rootBody = r.Body
			}
			if err := publishThread(rootBody, r.Publish != "reply", r.PublishHistory); err != nil {
				return nil, fmt.Errorf("publish thread: %w", err)
			}
			if r.Publish == "reply" {
				publishedAsRoot = true
				if posted.RootID != 0 {
					replyGithubIDs[r.ID] = posted.RootID
					_ = w.ExecuteActivity("saveReactionGithubID", map[string]any{
						"id": r.ID, "githubId": posted.RootID,
					}, nil)
				}
			}
		}
		// Still local after this reply — remember it, so a later publish can
		// offer to bring the earlier conversation along (PublishHistory).
		if r.Source == "ui" && posted.RootID == 0 {
			if body := strings.TrimSpace(r.Body); body != "" && body != resolveSentinel {
				localReplies = append(localReplies, localReply{ID: r.ID, Body: r.Body})
			}
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
		if r.Source == "ui" && !publishedAsRoot {
			if isPRWide(in.Kind) {
				if !r.Done {
					var mirrored postResult
					_ = w.ExecuteActivity("postGithubIssueComment", map[string]any{
						"pr": in.PR, "body": r.Body,
					}, &mirrored)
					if mirrored.RootID != 0 {
						replyGithubIDs[r.ID] = mirrored.RootID
						_ = w.ExecuteActivity("saveReactionGithubID", map[string]any{
							"id": r.ID, "githubId": mirrored.RootID,
						}, nil)
					}
				}
			} else {
				if body := strings.TrimSpace(r.Body); body != "" && body != resolveSentinel {
					var mirrored postResult
					_ = w.ExecuteActivity("replyGithub", map[string]any{
						"pr": in.PR, "rootId": posted.RootID, "body": r.Body,
					}, &mirrored)
					if mirrored.RootID != 0 {
						replyGithubIDs[r.ID] = mirrored.RootID
						_ = w.ExecuteActivity("saveReactionGithubID", map[string]any{
							"id": r.ID, "githubId": mirrored.RootID,
						}, nil)
					}
				}
				if r.Done {
					_ = w.ExecuteActivity("resolveGithubThread", map[string]any{
						"pr": in.PR, "rootId": posted.RootID,
					}, nil)
				}
			}
		}
		// A resolve deliberately does NOT end this Execution any more: the
		// reviewer can unresolve the thread again (the "unresolve" action above),
		// and a completed Execution could never accept that Signal. The thread
		// therefore keeps waiting, like claudeChatWorkflow's own loop — only a
		// "delete" ends it. Consequence, recorded on purpose: a thread resolved
		// BEFORE this change has already completed and stays unresolvable
		// forever. The thread's GitHub poller stops itself while the comment is
		// resolved (see poll) so a resolved thread costs nothing.
	}
}

// StartCodeComment posts the comment (synchronously, inside StartWorkflow) and
// launches the GitHub poller. Returns the Run ID (== the comment ID).
func (m *TaskManager) StartCodeComment(ctx context.Context, in CodeCommentInput) (string, error) {
	runID, err := m.engine.StartWorkflow(WorkflowTaskCodeComment, in)
	if err != nil {
		return "", err
	}
	prRunID, err := m.ensurePRStatus(canonRepo(in.Repo), in.PR)
	if err != nil {
		m.logf("task_code_comment: ensure pr_status pr=%d: %v", in.PR, err)
		prRunID = ""
	}
	rootID, err := m.rootID(runID)
	if err != nil {
		return runID, err
	}
	if rootID != 0 {
		// The poller must outlive this call: ctx here is typically the HTTP
		// request context (handleTaskCodeComment), which is cancelled the
		// moment the response is written — a poller started on it exits at
		// its first tick, so replies to an app-placed comment silently never
		// arrived until a restart's ResumePolling picked the thread up again.
		// Use the server-lifetime context (SetRuntime), exactly like the
		// reopenComment Activity does; fall back to ctx for a one-shot caller
		// that never called SetRuntime (tests, CLI).
		pollCtx := m.baseCtx
		if pollCtx == nil {
			pollCtx = ctx
		}
		go m.poll(pollCtx, runID, canonRepo(in.Repo), in.PR, rootID, prRunID)
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
func (m *TaskManager) EnsurePRStatus(repo string, pr int) (string, error) {
	return m.ensurePRStatus(repo, pr)
}

// ensurePRStatus returns the Run ID of the pr_status tracker for pr, starting one
// if none is live yet (one tracker per PR, reused across restarts).
func (m *TaskManager) ensurePRStatus(repo string, pr int) (string, error) {
	key := prKey{repo, pr}
	m.mu.Lock()
	if id, ok := m.prRuns[key]; ok {
		m.mu.Unlock()
		return id, nil
	}
	if id := m.findPRStatusLocked(repo, pr); id != "" {
		m.prRuns[key] = id
		m.mu.Unlock()
		return id, nil
	}
	// DeferLow: pr_status is fire-and-forget (the UI polls the read model and
	// never awaits this start), so its one slow LLM step, generatePRSummary,
	// must not block the caller — at startup ResumePolling ensures a tracker per
	// PR on the startup goroutine, and a synchronous summary there delays
	// ListenAndServe. The generatePRSummary activity is PriorityLow, so this
	// returns as soon as the fast basics stage is recorded and the summary +
	// statuses drain in the background (progressive load, exactly as designed).
	id, err := m.engine.StartWorkflowDeferLow(WorkflowPRStatus, PRStatusInput{Repo: repo, PR: pr})
	if err != nil {
		m.mu.Unlock()
		return "", err
	}
	m.prRuns[key] = id
	m.mu.Unlock()

	// Start the ingest-refresh poller for this PR's tracker — only when a
	// server runtime is actually driving background pollers (SetRuntime), and
	// only right here, when the Execution is genuinely new (a restart's
	// already-existing tracker is instead picked up by
	// ResumePRStatusPolling).
	if m.runtimeReady {
		go m.pollIngestRefresh(m.baseCtx, id, repo, pr)
		// Import existing GitHub comments as live threads, and keep polling for
		// new ones on the same heartbeat cadence (mirrors pollIngestRefresh).
		go m.pollImportComments(m.baseCtx, id, repo, pr)
	}
	return id, nil
}

// findPRStatusLocked scans for a running/waiting pr_status tracker for pr. It
// reads only the engine (no TaskManager state), so it is safe to call while
// holding m.mu.
func (m *TaskManager) findPRStatusLocked(repo string, pr int) string {
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
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr && canonRepo(pin.Repo) == repo {
			return r.ID
		}
	}
	return ""
}

// primePRRunsLocked fills m.prRuns, for every pr not already cached, from a
// single already-fetched runs slice — the bulk counterpart of
// findPRStatusLocked. ResumePolling calls this once, before its loop over
// (potentially many) waiting comment-runs, so that loop's per-comment
// m.ensurePRStatus never has to fall back to findPRStatusLocked's own
// O(runs) scan (which would otherwise run once per distinct PR the loop
// encounters, i.e. an O(runs) rescan per PR on top of the O(runs) this
// function already does once). Must be called while holding m.mu.
func (m *TaskManager) primePRRunsLocked(runs []tembed.RunRecord) {
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
		if json.Unmarshal(in, &pin) != nil {
			continue
		}
		if _, ok := m.prRuns[prKey{canonRepo(pin.Repo), pin.PR}]; !ok {
			m.prRuns[prKey{canonRepo(pin.Repo), pin.PR}] = r.ID
		}
	}
}

// EnsureRelations makes sure a build_relations Execution exists for pr and has
// (re)built its relations. It starts one if none is live (the initial build runs
// synchronously inside StartWorkflow); otherwise it signals a rebuild. One
// Execution per PR, reused across restarts. Called after a successful ingest.
func (m *TaskManager) EnsureRelations(ctx context.Context, repo string, pr int) {
	key := prKey{repo, pr}
	m.mu.Lock()
	runID := m.relRuns[key]
	if runID == "" {
		runID = m.findBuildRelationsLocked(repo, pr)
	}
	m.mu.Unlock()

	if runID == "" {
		id, err := m.engine.StartWorkflow(WorkflowBuildRelations, BuildRelationsInput{Repo: repo, PR: pr})
		if err != nil {
			m.logf("build_relations: start pr=%d: %v", pr, err)
			return
		}
		m.mu.Lock()
		m.relRuns[key] = id
		m.mu.Unlock()
		return
	}
	m.mu.Lock()
	m.relRuns[key] = runID
	m.mu.Unlock()
	if err := m.engine.SignalWorkflow(runID, SignalRebuild, json.RawMessage("{}")); err != nil {
		m.logf("build_relations: rebuild signal pr=%d: %v", pr, err)
	}
}

// findBuildRelationsLocked scans for a running/waiting build_relations Execution
// for pr. Reads only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findBuildRelationsLocked(repo string, pr int) string {
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
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr && canonRepo(pin.Repo) == repo {
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
func (m *TaskManager) EnsureApprovals(repo string, pr int) (string, error) {
	key := prKey{repo, pr}
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.apprRuns[key]; ok {
		return id, nil
	}
	if id := m.findApproveLocked(repo, pr); id != "" {
		m.apprRuns[key] = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowApprove, ApproveInput{Repo: repo, PR: pr})
	if err != nil {
		return "", err
	}
	m.apprRuns[key] = id
	return id, nil
}

// EnsureIgnoreComment ensures an ignore_comment tracker exists for pr (starting
// one if none is live) and returns its Run ID. The UI calls this on page load so
// it has a Run ID to signal ignore/un-ignore to; the tracker is reused across
// restarts (its waiting Execution is re-driven by engine.Recover). Starting/
// reusing an Execution is the sanctioned UI write path. Mirrors EnsureApprovals.
func (m *TaskManager) EnsureIgnoreComment(repo string, pr int) (string, error) {
	key := prKey{repo, pr}
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.ignRuns[key]; ok {
		return id, nil
	}
	if id := m.findIgnoreCommentLocked(repo, pr); id != "" {
		m.ignRuns[key] = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowIgnoreComment, IgnoreCommentInput{Repo: repo, PR: pr})
	if err != nil {
		return "", err
	}
	m.ignRuns[key] = id
	return id, nil
}

// findIgnoreCommentLocked scans for a running/waiting ignore_comment tracker for
// pr. It reads only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findIgnoreCommentLocked(repo string, pr int) string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowIgnoreComment {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin IgnoreCommentInput
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr && canonRepo(pin.Repo) == repo {
			return r.ID
		}
	}
	return ""
}

// findApproveLocked scans for a running/waiting approve tracker for pr. It reads
// only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findApproveLocked(repo string, pr int) string {
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
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr && canonRepo(pin.Repo) == repo {
			return r.ID
		}
	}
	return ""
}

// EnsureAutoWarn ensures the single auto_warn tracker for the repo exists
// (starting one if none is live) and returns its Run ID. The UI calls this on
// load so the toggle next to the theme button has a Run ID to signal to; the
// tracker is reused across restarts. Starting/reusing an Execution is the
// sanctioned UI write path. Mirrors EnsureInbox.
func (m *TaskManager) EnsureAutoWarn() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.autoWarnRun != "" {
		return m.autoWarnRun, nil
	}
	if id := m.findAutoWarnRunLocked(); id != "" {
		m.autoWarnRun = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowAutoWarn, AutoWarnInput{Repo: m.repo})
	if err != nil {
		return "", err
	}
	m.autoWarnRun = id
	return id, nil
}

// findAutoWarnRunLocked scans for a running/waiting auto_warn Execution for
// m.repo. It reads only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findAutoWarnRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowAutoWarn {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin AutoWarnInput
		if json.Unmarshal(in, &pin) == nil && pin.Repo == m.repo {
			return r.ID
		}
	}
	return ""
}

// EnsureAutoIngestPref ensures the single auto_ingest_pref tracker for the
// repo exists (starting one if none is live) and returns its Run ID. The UI
// calls this on load so the toggle (settings page + /pr-overview header) has
// a Run ID to signal to; the tracker is reused across restarts. Mirrors
// EnsureAutoWarn.
func (m *TaskManager) EnsureAutoIngestPref() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.autoIngestPrefRun != "" {
		return m.autoIngestPrefRun, nil
	}
	if id := m.findAutoIngestPrefRunLocked(); id != "" {
		m.autoIngestPrefRun = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowAutoIngestPref, AutoIngestPrefInput{Repo: m.repo})
	if err != nil {
		return "", err
	}
	m.autoIngestPrefRun = id
	return id, nil
}

// findAutoIngestPrefRunLocked scans for a running/waiting auto_ingest_pref
// Execution for m.repo. It reads only the engine, so it is safe to call
// while holding m.mu.
func (m *TaskManager) findAutoIngestPrefRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowAutoIngestPref {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin AutoIngestPrefInput
		if json.Unmarshal(in, &pin) == nil && pin.Repo == m.repo {
			return r.ID
		}
	}
	return ""
}

// AutoIngestPrefMode reports the reviewer's current preference for automatic
// review-tree generation ("off"|"own"|"all") — read-only, backs
// GET /api/autoingestpref and autoIngestOwnPRs. A nil autoingestpref module
// (not wired, e.g. some test harnesses) defaults to "own", matching
// modules/autoingestpref.Mode's own default.
func (m *TaskManager) AutoIngestPrefMode(ctx context.Context) (string, error) {
	if m.autoingestpref == nil {
		return autoingestpref.ModeOwn, nil
	}
	return m.autoingestpref.Mode(ctx, m.repo)
}

// EnsureLangPref ensures the single lang_pref tracker for the repo exists
// (starting one if none is live) and returns its Run ID. The settings page
// calls this on load so its three language toggles have a Run ID to signal
// to; the tracker is reused across restarts. Mirrors EnsureAutoIngestPref.
func (m *TaskManager) EnsureLangPref() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.langPrefRun != "" {
		return m.langPrefRun, nil
	}
	if id := m.findLangPrefRunLocked(); id != "" {
		m.langPrefRun = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowLangPref, LangPrefInput{Repo: m.repo})
	if err != nil {
		return "", err
	}
	m.langPrefRun = id
	return id, nil
}

// findLangPrefRunLocked scans for a running/waiting lang_pref Execution for
// m.repo. It reads only the engine, so it is safe to call while holding m.mu.
func (m *TaskManager) findLangPrefRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowLangPref {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin LangPrefInput
		if json.Unmarshal(in, &pin) == nil && pin.Repo == m.repo {
			return r.ID
		}
	}
	return ""
}

// LangFor reports the language for one output type ("ui"|"explain"|"reply") —
// read-only, called from GET /api/langpref and from the Activities that build
// a Claude prompt (see langDirective in explain.go). A nil langpref module
// (not wired, e.g. a test harness) defaults to Dutch, matching
// modules/langpref.Lang's own default, so nothing about an existing prompt
// changes unless a reviewer really picked English.
func (m *TaskManager) LangFor(ctx context.Context, kind string) string {
	if m == nil || m.langpref == nil {
		return langpref.LangNL
	}
	lang, err := m.langpref.Lang(ctx, m.repo, kind)
	if err != nil || !langpref.ValidLang(lang) {
		return langpref.LangNL
	}
	return lang
}

// LangPrefAll reports every output type's language — backs GET /api/langpref.
func (m *TaskManager) LangPrefAll(ctx context.Context) (map[string]string, error) {
	if m.langpref == nil {
		out := map[string]string{}
		for _, k := range langpref.Kinds {
			out[k] = langpref.LangNL
		}
		return out, nil
	}
	return m.langpref.All(ctx, m.repo)
}

// EnsureAppSettings ensures the single, global app_settings tracker exists
// (starting one if none is live) and returns its Run ID. The settings page
// calls this on load so its aliases/praise-words edits have a Run ID to
// signal to; the tracker is reused across restarts. Mirrors EnsureAutoWarn,
// minus the repo scope — there is only ever one such Execution at all.
func (m *TaskManager) EnsureAppSettings() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.appSettingsRun != "" {
		return m.appSettingsRun, nil
	}
	if id := m.findAppSettingsRunLocked(); id != "" {
		m.appSettingsRun = id
		return id, nil
	}
	id, err := m.engine.StartWorkflow(WorkflowAppSettings, AppSettingsInput{})
	if err != nil {
		return "", err
	}
	m.appSettingsRun = id
	return id, nil
}

// StartDebugLog starts ONE debug_log Execution for one already-validated
// batch (or a clear). No dedup and no reuse: every batch is its own one-shot
// Execution — see WorkflowDebugLog for why this is not a tracker.
func (m *TaskManager) StartDebugLog(in DebugLogInput) (string, error) {
	if m.engine == nil {
		return "", fmt.Errorf("no engine")
	}
	return m.engine.StartWorkflow(WorkflowDebugLog, in)
}

// IgnoreFailedRuns runs ONE ignore_runs Execution to completion (signal-less,
// so StartWorkflow drives it inline — mirrors startCleanup) and reports how
// many failures were really deleted. This is the sanctioned write path: the
// UI only starts the Execution, its own Activity does every deletion.
func (m *TaskManager) IgnoreFailedRuns(runIDs []string) (*IgnoreRunsResult, error) {
	if m.engine == nil {
		return nil, fmt.Errorf("no engine")
	}
	runID, err := m.engine.StartWorkflow(WorkflowIgnoreRuns, IgnoreRunsInput{RunIDs: runIDs})
	if err != nil {
		return nil, err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return nil, err
	}
	if status == tembed.StatusFailed {
		return nil, fmt.Errorf("ignore runs failed (run %s)", runID)
	}
	var res IgnoreRunsResult
	if err := m.engine.Result(runID, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// findAppSettingsRunLocked scans for a running/waiting app_settings
// Execution — no repo filter, since AppSettingsInput carries none and there is
// only ever one such Execution.
func (m *TaskManager) findAppSettingsRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowAppSettings {
			continue
		}
		if r.Status != tembed.StatusRunning && r.Status != tembed.StatusWaiting {
			continue
		}
		return r.ID
	}
	return ""
}

// AutoWarnEnabled reports whether the automatic code_warning trigger is
// currently turned on — read-only, backs GET /api/autowarn. A nil autowarn
// module (not wired, e.g. some test harnesses) defaults to enabled, matching
// modules/autowarn.Enabled's own default.
func (m *TaskManager) AutoWarnEnabled(ctx context.Context) (bool, error) {
	if m.autowarn == nil {
		return true, nil
	}
	return m.autowarn.Enabled(ctx, m.repo)
}

// autoStartCodeWarning is the server-side counterpart of the "/" menu's
// manual "Diepgravend onderzoek" trigger (StartCodeWarning): fired
// fire-and-forget (its own goroutine, spawned from the autoStartCodeWarning
// Activity) whenever real new code lands — the very first ingest of a PR, or
// a later delta-refresh that found genuinely new commits (see
// buildRelationsWorkflow/prStatusWorkflow) — so a reviewer sees AI warnings
// without clicking the menu item. A plain "rebuild" Signal (manual
// "Regenereren" without new commits) never reaches this. Checks the reviewer's
// own on/off preference (AutoWarnEnabled) first — the toggle next to the
// theme button — and does nothing when it's off; a manual trigger from the
// menu is never gated by it. StartCodeWarning itself is a deliberate,
// repeatable refresh (supersedeFileWarnings replaces the previous run's
// findings for the files in scope), so calling it again here is "refresh the
// risk check", not "duplicate it".
func (m *TaskManager) autoStartCodeWarning(repo string, pr int) {
	enabled, err := m.AutoWarnEnabled(context.Background())
	if err != nil {
		m.logf("code_warning: auto-start pr=%d: check enabled: %v", pr, err)
		return
	}
	if !enabled {
		return
	}
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		m.logf("code_warning: auto-start pr=%d: %v", pr, err)
	}
}

// autoStartKiloCheck fires a claude_chat conversation automatically on a
// freshly imported kilo-code review comment (see isKiloComment,
// comment_import.go), gated by the SAME "Live AI assistent" toggle as
// autoStartCodeWarning/explain_code/comment_titles (see CLAUDE.md's "A second,
// unrelated toggle…" section) — reviewer request: verify whether kilo's own
// finding actually holds against the real code and give a clearer, shorter
// summary, with an optional fix proposal. Claude gets its usual shell access
// for the turn (runOneClaudeTurn tries this for every turn), so it can read
// the real code itself rather than trusting the snippet in the prompt.
//
// Fire-and-forget, its own goroutine (see importPRComments) — the import loop
// must not block on a Claude call. commentRunID is the task_code_comment
// thread's own Run ID, already started by the caller; StartClaudeChat derives
// the chat's Run ID from it and makes the chat a child of that thread.
//
// Only fires for a NEWLY imported thread (see the call site) — no backfill for
// a kilo comment imported before this existed, by explicit product decision.
func (m *TaskManager) autoStartKiloCheck(repo string, pr int, commentRunID string, in CodeCommentInput) {
	enabled, err := m.AutoWarnEnabled(context.Background())
	if err != nil {
		m.logf("kilo check: auto-start pr=%d comment=%s: check enabled: %v", pr, commentRunID, err)
		return
	}
	if !enabled {
		return
	}
	chatRunID, err := m.StartClaudeChat(ClaudeChatInput{Repo: repo, PR: pr, CommentID: commentRunID})
	if err != nil {
		m.logf("kilo check: auto-start pr=%d comment=%s: start chat: %v", pr, commentRunID, err)
		return
	}
	sig := ChatMessageSignal{
		ID:     "sys-" + newUIReactionID(),
		Author: "reviewer",
		Body:   kiloCheckPrompt(in),
		Action: chatActionAutoCheck,
	}
	if err := m.engine.SignalWorkflow(chatRunID, SignalMessage, sig); err != nil {
		m.logf("kilo check: auto-start pr=%d comment=%s: send prompt: %v", pr, commentRunID, err)
	}
}

// kiloCheckPrompt builds the automatic first turn for autoStartKiloCheck —
// Dutch, matching every other reviewer-facing prompt/label in this app. Kilo's
// own wording is quoted verbatim (as a Markdown blockquote) because this turn
// carries NO other context: ChatMessageSignal.Context is empty here, so the
// quote is the only thing telling Claude what the finding even was. The
// reviewer, however, already has kilo's comment open right next to this chat,
// so the frontend renders that blockquote COLLAPSED (see claudeMessageBody /
// splitAutoCheckQuote in src/ClaudeChat.mjs).
//
// The closing instruction therefore explicitly forbids repeating or
// summarizing kilo's text — reviewer request ("daar hoef je niet de opmerking
// te herhalen van kilo, maar het kort en krachtig"): a verdict plus a sentence
// or two of reasoning, optionally one concrete fix.
func kiloCheckPrompt(in CodeCommentInput) string {
	var b strings.Builder
	b.WriteString("Kilo (de geautomatiseerde code-review bot) heeft hier een opmerking geplaatst")
	if in.File != "" {
		fmt.Fprintf(&b, " in `%s`", in.File)
		if in.Line > 0 {
			fmt.Fprintf(&b, ", regel %d", in.Line)
		}
	}
	b.WriteString(":\n\n> ")
	b.WriteString(strings.ReplaceAll(strings.TrimSpace(in.Body), "\n", "\n> "))
	b.WriteString("\n\nControleer aan de hand van de echte code of kilo hier gelijk heeft. Herhaal of vat kilo's ")
	b.WriteString("opmerking NIET samen — de reviewer heeft die er al naast staan. Antwoord kort en krachtig: begin ")
	b.WriteString("met je oordeel (klopt / klopt deels / klopt niet), daarna een of twee zinnen waarom. Zie je een ")
	b.WriteString("concrete verbetering, stel er dan één voor.")
	return b.String()
}

// autoIngestOwnPRs kicks off the ingest pipeline for every PR in this
// snapshot that eligibleAutoIngestPRs (inbox.go) says the reviewer's own
// auto_ingest_pref preference covers — "mijn eigen prs, daarvan mogen de
// trees automatisch worden gegenereerd" turned into real triggers. Runs from
// inside the refreshInbox Activity, i.e. on the pr_inbox tracker's own poll
// cadence (see pollInbox — 1 min while a reviewer is active, else 10 min), so
// an eligible PR gets a tree within one poll interval without anyone
// visiting /pr-overview by hand.
//
// Deliberately a no-op offline (ghDisabled): under SLASH_GITHUB=off the
// snapshot comes from a fixture, not a real repo — the fixture's own
// "reindert-vetter"-authored rows must never trigger a real StartIngest
// during a test run.
//
// Fire-and-forget per eligible PR (mirrors TriggerIngestRefreshCheck): the
// ingest pipeline itself can take a while, and this Activity must stay fast —
// SignalWorkflow runs the whole Activity inline, and the UI awaits the
// "refresh" Signal synchronously on every /pr-overview page load. Gated on
// m.runtimeReady like every other background trigger — a one-shot CLI caller
// never starts this.
func (m *TaskManager) autoIngestOwnPRs(ctx context.Context, myLogin string, sections []inboxSection) {
	if !m.runtimeReady || ghDisabled() {
		return
	}
	mode, err := m.AutoIngestPrefMode(ctx)
	if err != nil {
		m.logf("pr_inbox: auto-ingest: read pref: %v", err)
		return
	}
	if mode == autoingestpref.ModeOff {
		return
	}
	for _, key := range eligibleAutoIngestPRs(mode, myLogin, sections) {
		m.mu.Lock()
		if m.autoIngestTried[key] {
			m.mu.Unlock()
			continue
		}
		m.autoIngestTried[key] = true
		m.mu.Unlock()
		go m.autoIngestOne(m.baseCtx, key.Repo, key.PR)
	}
}

// autoIngestOne runs the same pipeline handleIngest/the CLI run does:
// StartIngest, then EnsureRelations, then EnsurePRStatus, so the new
// tracker's own pollers (ingest-refresh, comment import) start right away
// too — see .claude/docs/blocks-and-ingest.md. Best-effort: a failure here is
// a background trigger, exactly like generatePRSummary or the automatic
// code_warning worker, and simply leaves the PR to be generated by hand or on
// a later poll; it still surfaces via GET /api/problems like any other failed
// run (see run_errors.go). autoIngestTried is deliberately never cleared on
// failure, so a persistently broken PR does not retry on every single poll —
// clearing it on success would be a no-op anyway, since a successful ingest's
// hasGraph then excludes the PR from eligibleAutoIngestPRs.
func (m *TaskManager) autoIngestOne(ctx context.Context, repo string, pr int) {
	ctx, cancel := context.WithTimeout(ctx, ingestTimeout)
	defer cancel()
	if _, err := m.StartIngest(ctx, repo, pr); err != nil {
		m.logf("pr_inbox: auto-ingest pr=%d: %v", pr, err)
		return
	}
	m.EnsureRelations(ctx, repo, pr)
	if _, err := m.EnsurePRStatus(repo, pr); err != nil {
		m.logf("pr_inbox: auto-ingest ensure pr_status pr=%d: %v", pr, err)
	}
}

// EnsureInbox starts (or reuses) the single pr_inbox Execution for the repo
// (a fast, DB-only step, so it returns with the Run ID resolved right away),
// then — once the ready gate opens (see waitReady; a no-op if it was never
// armed) — fetches an initial snapshot and launches the refresh poller.
// Idempotent across restarts: it reuses an existing running/waiting
// Execution. The initial fetch used to run synchronously right here, "so
// /api/inbox has a snapshot the moment the server comes up" — deliberately
// traded for a faster server bind: see ArmReadyGate.
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

	go func() {
		m.waitReady()
		// Initial refresh runs the fetch Activity, so /api/inbox has a
		// snapshot as soon as the server is actually serving requests.
		if err := m.engine.SignalWorkflow(runID, SignalRefresh, json.RawMessage("{}")); err != nil {
			m.logf("pr_inbox: initial refresh: %v", err)
		}
		m.pollInbox(ctx, runID)
	}()
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
	m.waitReady()
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

// ingestRefreshNeeded reports whether an observed remote head SHA warrants an
// ingest-refresh Signal, given the head SHA the blocks were last ingested from.
//
// "They differ" is deliberately not enough. A chat edit that landed on the PR's
// local pending ref (chat_shadow.go) is ingested at that LOCAL commit, which
// GitHub hasn't seen yet — so remote and stored differ on every single tick, and
// a bare inequality check would rewind the review tree to the older remote tip
// over and over, undoing exactly the "meteen zichtbaar" this feature exists
// for. So a refresh is only needed when the stored head does NOT already
// contain the remote tip.
//
// Once the reviewer pushes, the remote tip IS the stored head again and this
// falls back to the plain equality case. If someone else pushes on top of an
// unpushed local commit, the remote tip is no longer contained, the refresh
// fires, and the tree follows GitHub again until the pending commit is pushed —
// a deliberate degrade (GitHub is the shared truth), not a silent conflict.
func ingestRefreshNeeded(ctx context.Context, remoteHead, storedHead string) bool {
	if remoteHead == "" || remoteHead == storedHead {
		return false
	}
	if _, err := runGit(ctx, "merge-base", "--is-ancestor", remoteHead, storedHead); err == nil {
		return false
	}
	return true
}

// pollIngestRefresh checks, on the heartbeat-driven cadence (fast while a
// heartbeat for prRunID arrived within heartbeatWindow, else slow — same gate
// as poll/pollInbox), whether the PR's live head SHA has moved past what was
// last ingested. If so it signals the pr_status tracker (SignalPRState, State
// "" so it's read as an ingest-refresh request rather than a lifecycle
// transition) to run refreshIngestDelta. It stops once the tracker itself is
// done (merged/closed) — mirrors poll's shutdown check.
//
// See ingestRefreshNeeded for why "the SHAs differ" is not enough on its own.
func (m *TaskManager) pollIngestRefresh(ctx context.Context, prRunID string, repo string, pr int) {
	m.waitReady()
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

		if !m.checkIngestRefreshOnce(ctx, prRunID, repo, pr) {
			return
		}
	}
}

// checkIngestRefreshOnce runs a single ingest-refresh check: it signals the
// pr_status tracker (SignalPRState) if the PR's live head SHA has moved past
// what was last ingested. Shared by pollIngestRefresh's own ticker and
// TriggerIngestRefreshCheck's immediate on-open check — see the latter for why
// that second caller exists. Returns false once the tracker itself is done
// (merged/closed), the same shutdown signal pollIngestRefresh's loop used to
// detect inline; true otherwise (including "nothing to do" and error cases,
// which only log and keep the tracker alive for the next check).
func (m *TaskManager) checkIngestRefreshOnce(ctx context.Context, prRunID string, repo string, pr int) bool {
	status, err := m.engine.Status(prRunID)
	if err != nil || status == tembed.StatusCompleted || status == tembed.StatusFailed {
		return false
	}

	// Local-only, and deliberately BEFORE the gh call below: a chat edit that
	// was committed in the PR's checkout but never landed on the pending ref
	// leaves the tree behind forever, and the remote head SHA this function
	// looks at never moves for such a commit — so nothing else can ever
	// notice it. See chat_land_backstop.go.
	m.repairMissedLanding(ctx, repo, pr)

	meta, err := fetchPRMeta(ctx, repo, pr)
	if err != nil {
		m.logf("pr_status: ingest refresh check pr=%d: %v", pr, err)
		return true
	}
	_, head, ok, err := loadIngestSHAs(m.db, repo, pr)
	if err != nil {
		m.logf("pr_status: load ingest state pr=%d: %v", pr, err)
		return true
	}
	if !ok || !ingestRefreshNeeded(ctx, meta.HeadRefOid, head) {
		return true // no prior ingest yet, nothing new since, or already ahead
	}
	sig := PRStateSignal{BaseSHA: meta.BaseRefOid, HeadSHA: meta.HeadRefOid}
	if err := m.engine.SignalWorkflow(prRunID, SignalPRState, sig); err != nil {
		m.logf("pr_status: signal ingest refresh pr=%d: %v", pr, err)
	}
	return true
}

// TriggerIngestRefreshCheck runs one checkIngestRefreshOnce immediately, in the
// background, instead of waiting for pollIngestRefresh's own ticker (up to
// m.interval/m.idle after its last check). handlePRStatusStart calls this on
// every "open a review tree" page load, so a PR head that moved since the last
// check is picked up the moment the tree is opened, not on the next tick. A
// no-op when background pollers aren't running (SetRuntime/runtimeReady) —
// mirrors the same gate ensurePRStatus uses before spawning pollIngestRefresh.
func (m *TaskManager) TriggerIngestRefreshCheck(prRunID, repo string, pr int) {
	if !m.runtimeReady {
		return
	}
	go m.checkIngestRefreshOnce(m.baseCtx, prRunID, repo, pr)
}

// pollImportComments imports existing GitHub comments (review-diff threads and
// PR-wide issue/review comments) as live task_code_comment Executions, then keeps
// checking for new ones on the same heartbeat-driven cadence as pollIngestRefresh
// (fast while a heartbeat for prRunID arrived within heartbeatWindow, else slow).
// It stops once the pr_status tracker is done (merged/closed). Reading GitHub in
// glue mirrors poll/pollInbox; the only write is starting an Execution (the
// sanctioned path), made idempotent by the deterministic gh-<id> Run ID.
func (m *TaskManager) pollImportComments(ctx context.Context, prRunID string, repo string, pr int) {
	m.waitReady()
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	// Run one import immediately (don't wait a whole tick to surface existing
	// comments on first load), then gate later ticks to the cadence.
	m.importPRComments(ctx, repo, pr)
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
		m.importPRComments(ctx, repo, pr)
	}
}

// importPRComments fetches pr's existing GitHub comments, maps each to a
// CodeCommentInput, and starts a task_code_comment Execution per comment with a
// deterministic gh-<id> Run ID — so a re-import (a re-poll, a restart) is a
// StartWorkflowID no-op rather than a duplicate. It then launches the per-thread
// reply poller for any thread not already being polled. The GitHub fetch is a
// read (like poll/pollInbox); the Execution start is the only write.
func (m *TaskManager) importPRComments(ctx context.Context, repo string, pr int) {
	var blocks []Block
	if m.db != nil {
		var err error
		if blocks, err = blocksByPR(m.db, repo, pr); err != nil {
			m.logf("import comments: blocks pr=%d: %v", pr, err)
			// Continue anyway — general (PR-wide) comments don't need blocks, and a
			// review comment with no blocks just degrades to PR-wide.
		}
	}

	var inputs []CodeCommentInput
	if reviews, err := m.ghFor(repo).FetchReviewComments(ctx, pr); err != nil {
		m.logf("import comments: fetch review comments pr=%d: %v", pr, err)
	} else {
		for _, rc := range reviews {
			inputs = append(inputs, mapReviewComment(m.dataDir, repo, pr, blocks, rc))
		}
	}
	if general, err := m.ghFor(repo).FetchGeneralComments(ctx, pr); err != nil {
		m.logf("import comments: fetch general comments pr=%d: %v", pr, err)
	} else {
		for _, gc := range general {
			inputs = append(inputs, mapGeneralComment(repo, pr, gc))
		}
	}

	prRunID, err := m.ensurePRStatus(repo, pr)
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
	// Comments already in the read-model whose avatar column is still empty: a
	// comment imported before the avatar was threaded through never re-runs its
	// Execution (StartWorkflowID reuses the gh-<id> Run ID), so its picture is
	// backfilled through the workflow below instead. Read-only lookup here; the
	// write is the "avatar" Signal's own Activity.
	avatarMissing := map[string]bool{}
	// The same read-model list also feeds applyGithubResolves below.
	var existing []comments.Comment
	if m.comments != nil {
		if list, err := m.comments.List(ctx, repo, pr); err != nil {
			m.logf("import comments: list pr=%d: %v", pr, err)
		} else {
			existing = list
			for _, c := range list {
				if c.AvatarURL == "" {
					avatarMissing[c.ID] = true
				}
			}
		}
	}
	for _, in := range inputs {
		if known[in.ImportedRootID] {
			runID := importedRunID(in.ImportedRootID)
			// Once per process per thread: a thread that already completed/failed
			// (a resolved or deleted comment) can't be signaled anymore, and
			// retrying it every poll tick would only repeat the same log line.
			m.mu.Lock()
			tried := m.avatarTried[runID]
			m.avatarTried[runID] = true
			m.mu.Unlock()
			if !tried && in.AvatarURL != "" && avatarMissing[runID] {
				// A terminal (failed/completed) run can never accept a Signal
				// again (see engine.SignalWorkflow's own "already failed/
				// completed" check) — check the status first instead of
				// discovering that the hard way and logging the same
				// deterministic error on every server restart forever
				// (avatarTried above only dedups within one process, so it
				// doesn't survive a restart on its own).
				switch status, err := m.engine.Status(runID); {
				case err != nil:
					m.logf("import comments: avatar backfill run=%s: status: %v", runID, err)
				case status == tembed.StatusFailed || status == tembed.StatusCompleted:
					// Nothing to do — not an error, just permanently unreachable.
				default:
					if err := m.Signal(runID, ReactionSignal{
						ID: "sys-" + newUIReactionID(), Source: "github",
						Action: "avatar", AvatarURL: in.AvatarURL,
					}); err != nil {
						m.logf("import comments: avatar backfill run=%s: %v", runID, err)
					}
				}
			}
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
		// A freshly imported kilo-code finding gets an automatic claude_chat
		// verification turn — see autoStartKiloCheck's own doc comment. Only
		// reaches here for a NEW thread (a re-import of a known comment
		// `continue`s above), so this never re-fires for a comment already
		// seen — no backfill for threads imported before this existed, by
		// product decision.
		if isKiloComment(in.Author) {
			go m.autoStartKiloCheck(repo, pr, runID, in)
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
			go m.poll(ctx, runID, repo, pr, in.ImportedRootID, prRunID)
		}
	}

	m.applyGithubResolves(ctx, repo, pr, existing)
}

// applyGithubResolves mirrors GitHub's own "Resolve conversation" state onto
// the read-model. Nothing else did: the import reads comment BODIES, and the
// only way a thread used to become resolved locally was a reply literally
// containing "/resolve" (see FetchReplies). A thread someone resolved on
// github.com therefore stayed `open` here forever — no ✓, not dimmed, still
// marking its diff row with a 💬, and never folding into "Toon N goedgekeurde
// blokken" — which is exactly the "resolved op GitHub maar niet zichtbaar"
// report this exists for. `isResolved` lives only on the GraphQL reviewThread
// node, hence the separate ResolvedReviewThreads read (one round-trip per
// poll, alongside the two comment fetches this function's caller already
// does).
//
// It rides entirely on the EXISTING resolve path — the same `reply` Signal
// with the resolveSentinel body + Done that the reviewer's own "Resolve
// comment" sends — so there is no new workflow branch, Action or endpoint.
// Crucially it is sent with Source "github", and the reactions loop only
// mirrors OUT for Source "ui": nothing is written back to GitHub, which would
// be a pointless re-resolve of a thread that is already resolved there.
//
// Deliberately keyed on the comment's own GithubID rather than on "was this
// imported", so it covers a thread this app placed itself and the reviewer
// then resolved on github.com just as well — and deliberately NOT filtered by
// Kind: a review comment that simply couldn't be mapped to a block is stored
// as the PR-wide Kind "review" (mapReviewComment) yet still has a genuine,
// resolvable review thread behind it. Membership in the resolved set is the
// only filter needed; an issue comment's id is never in it, so a genuinely
// thread-less PR-wide comment can't match.
//
// No in-memory dedup is needed. Signalling is synchronous, so the status has
// already flipped to "resolved" by the time this returns, and the Status
// check below is what keeps the next poll tick quiet. A locally unresolved
// thread doesn't get re-resolved behind the reviewer's back either: the
// "unresolve" action unresolves the GitHub conversation too, so it drops out
// of this set at the same moment.
func (m *TaskManager) applyGithubResolves(ctx context.Context, repo string, pr int, existing []comments.Comment) {
	if m.comments == nil || m.gh == nil || len(existing) == 0 {
		return
	}
	// Cheap pre-check: don't ask GitHub at all when nothing could change.
	candidates := false
	for _, c := range existing {
		if c.Status == "open" && c.GithubID != 0 {
			candidates = true
			break
		}
	}
	if !candidates {
		return
	}
	resolved, err := m.ghFor(repo).ResolvedReviewThreads(ctx, pr)
	if err != nil {
		m.logf("import comments: resolved threads pr=%d: %v", pr, err)
		return
	}
	for _, c := range existing {
		if c.Status != "open" || c.GithubID == 0 || !resolved[c.GithubID] {
			continue
		}
		// A terminal run can never accept a Signal again — same check, and the
		// same "not an error, just permanently unreachable" reading, as the
		// avatar backfill above. A thread resolved back when a resolve still
		// completed the Execution is exactly such a run.
		switch status, err := m.engine.Status(c.ID); {
		case err != nil:
			m.logf("import comments: github resolve run=%s: status: %v", c.ID, err)
		case status == tembed.StatusFailed || status == tembed.StatusCompleted:
			// Nothing to do.
		default:
			if err := m.Signal(c.ID, ReactionSignal{
				ID: fmt.Sprintf("ghres-%d", c.GithubID), Source: "github",
				Body: resolveSentinel, Done: true,
			}); err != nil {
				m.logf("import comments: github resolve run=%s: %v", c.ID, err)
			}
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
func (m *TaskManager) poll(ctx context.Context, runID string, repo string, pr int, rootID int64, prRunID string) {
	// One poller per thread, and it exits again while the comment is resolved
	// (see the resolvedComment check below) — so a later reopen can start a
	// fresh one. See beginPolling for the handshake that makes that safe.
	if !m.beginPolling(runID) {
		return
	}
	defer func() {
		if m.endPolling(runID) {
			go m.poll(ctx, runID, repo, pr, rootID, prRunID)
		}
	}()
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
		// Stop while the thread is resolved. A resolve no longer completes the
		// Execution (it can be unresolved again, see the "unresolve" action in
		// taskCodeCommentWorkflow), so this is what keeps a resolved thread from
		// polling GitHub forever. The reopenComment Activity starts a fresh
		// poller when the thread is unresolved.
		if m.resolvedComment(runID) {
			return
		}
		// Stop once the PR is no longer open — another poller for the same PR may
		// already have recorded merged/closed on the tracker.
		if prRunID != "" {
			if s, err := m.engine.Status(prRunID); err == nil && (s == tembed.StatusCompleted || s == tembed.StatusFailed) {
				return
			}
		}

		replies, err := m.ghFor(repo).FetchReplies(ctx, pr, rootID)
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
				Author: r.Author, AvatarURL: r.AvatarURL, Body: r.Body, Done: r.Done,
			}
			if err := m.engine.SignalWorkflow(runID, SignalReply, sig); err != nil {
				m.logf("task_code_comment: signal run=%s: %v", runID, err)
			}
		}

		// Slow cadence only: check whether the PR merged/closed. Record it on the
		// pr_status tracker (best-effort) and stop polling this thread.
		if !active {
			state, err := m.ghFor(repo).PRState(ctx, pr)
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

// beginPolling claims the single poller slot for thread runID, reporting
// whether this caller may run it. When a poller is already registered it
// instead records a restart request: the running poller may be on its way out
// (it exits while the comment is resolved), and without this handshake a reopen
// that lands in exactly that window would leave the thread with no poller at
// all until the next server restart. Purely in-memory bookkeeping — no durable
// state, so it sits outside the workflow write boundary, like the heartbeat map.
func (m *TaskManager) beginPolling(runID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.polling[runID] {
		m.pollRestart[runID] = true
		return false
	}
	m.polling[runID] = true
	delete(m.pollRestart, runID)
	return true
}

// endPolling releases the poller slot for runID and reports whether someone
// asked for a restart while this poller was still registered (see
// beginPolling). The caller then starts a fresh poller, which immediately
// re-checks the thread's state and exits again if there is still nothing to do.
func (m *TaskManager) endPolling(runID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.polling, runID)
	restart := m.pollRestart[runID]
	delete(m.pollRestart, runID)
	return restart
}

// resolvedComment reports whether the comment thread runID is currently
// resolved — a read-only read-model lookup (Comment.ID == its thread's Run ID),
// so it is allowed anywhere. A missing comment or a read error reports false:
// the poller then just keeps running, which is the pre-existing behaviour.
func (m *TaskManager) resolvedComment(runID string) bool {
	if m.comments == nil {
		return false
	}
	c, found, err := m.comments.Get(context.Background(), runID)
	return err == nil && found && c.Status == "resolved"
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
