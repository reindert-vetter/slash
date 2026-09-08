package main

import (
	"context"
	"sync"
	"time"
)

// plan_assignee_live.go — a read-time fallback for the plan-page ticket card's
// "Toegewezen aan" row (src/plan.mjs, assigneeMark) when the STORED plan
// document carries no assignee at all.
//
// doc.Assignee/AssigneeAvatarURL are filled once, by the planLoadIssue
// Activity (plan_workflow.go), and then frozen in that Execution's durable
// history: tembed replay never re-runs an already-recorded Activity (see
// .claude/rules/workflow-determinism.md). A plan Execution started before
// this field existed, or one whose single planLoadIssue call happened to race
// a Jira assignment change, therefore shows a permanently empty assignee even
// once the ticket really has an owner — reported live for PROD-254: Jira says
// "Reindert Vetter", the plan page said "Niet toegewezen" (task5, this repo's
// review-shots).
//
// The fix stays outside the workflow entirely, same as `intent`/`artifacts` in
// handlePlan (plan_api.go): a plain, best-effort, LIVE read merged into the
// GET /api/plan response only, never written back into the stored document or
// the workflow history. A genuinely unassigned ticket still resolves to ""
// here, so the row keeps reading "Niet toegewezen" correctly.
//
// WRITE BOUNDARY: read-only, in-memory, process-lifetime cache with a short
// TTL — same operational carve-out as authStatusTTL (auth_status.go) and the
// names cache (usernames.go); see .claude/rules/workflows-write-boundary.md.
// The TTL exists because the page polls GET /api/plan every few seconds
// (POLL_MS in src/plan.mjs) and a live Jira lookup on every tick would be
// wasteful; it is short enough that a reassignment still shows up within a
// few minutes without a restart.
const planAssigneeLiveTTL = 5 * time.Minute

type planAssigneeEntry struct {
	assignee  string
	avatarURL string
	at        time.Time
}

var (
	planAssigneeMu    sync.Mutex
	planAssigneeCache = map[string]planAssigneeEntry{}
)

// liveAssigneeFallback returns the ticket's CURRENT assignee/avatar straight
// from Jira, cached for planAssigneeLiveTTL. Only called by handlePlan when
// the stored doc's own Assignee is empty — an already-populated doc is never
// second-guessed here (fillPlanSubtaskAssignees already pays that cost once,
// at plan-generation time, for the subtask rows). Best-effort: any failure
// (no jira client, acli hiccup) yields ("", "") and leaves the row exactly as
// the stored document already shows.
func liveAssigneeFallback(ctx context.Context, m *TaskManager, key string) (string, string) {
	if m == nil || m.jira == nil || key == "" {
		return "", ""
	}
	planAssigneeMu.Lock()
	if e, ok := planAssigneeCache[key]; ok && time.Since(e.at) < planAssigneeLiveTTL {
		planAssigneeMu.Unlock()
		return e.assignee, e.avatarURL
	}
	planAssigneeMu.Unlock()

	found, err := m.jira.IssuesByKey(ctx, []string{key})
	if err != nil || len(found) == 0 {
		return "", ""
	}
	assignee, avatarURL := found[0].Assignee, found[0].AssigneeAvatarURL

	planAssigneeMu.Lock()
	planAssigneeCache[key] = planAssigneeEntry{assignee: assignee, avatarURL: avatarURL, at: time.Now()}
	planAssigneeMu.Unlock()
	return assignee, avatarURL
}
