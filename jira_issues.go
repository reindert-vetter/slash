package main

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"

	"slash/modules/jira"
)

// jira_issues.go serves the two ISSUE sections of the PR overview — the work
// that comes BEFORE a pull request exists. The page reads top to bottom as one
// pipeline: "Needs your review" (a PR waiting for you), then "Planning" (what
// is in the active sprint), then "Todo" (what is still queued). See
// .claude/docs/pr-overview.md.
//
// WRITE BOUNDARY: GET /api/jira/issues writes nothing durable — it runs two
// read-only `acli` searches and keeps the outcome in one in-memory struct that
// is empty again after a restart. A module's READ methods may be called from
// anywhere (.claude/rules/workflows-write-boundary.md); only writes need a
// workflow. Same operational shape as auth_status.go, whose cache/TTL/?refresh
// pattern this deliberately mirrors.
//
// Deliberately NOT a tracker + read-model like the Jira bell feed
// (jira_notifications.go): nothing here has to survive a restart or be
// diffed against a previous state — there is no per-row read/unread state to
// remember, so a plain cached read is the smaller solution.

// jiraIssuesTTL is how long a fetched list is reused. Two `acli` searches cost
// several seconds each, and the overview polls; ?refresh=1 bypasses it.
const jiraIssuesTTL = 5 * time.Minute

// jiraIssuesLimit caps each of the two searches.
const jiraIssuesLimit = 40

// The two JQL queries behind the sections. Both are CONSTANTS — no reviewer
// input ever reaches acli (see modules/jira/search.go).
//
// planningJQL is deliberately literal: EVERYTHING assigned to you in the
// active sprint, whatever its status (Reindert: "alles wat in de actieve
// sprint op zijn naam staat"), most recently updated first.
const planningJQL = `assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC`

// todoJQL is the queue feeding that sprint: still To Do, still unresolved.
const todoJQL = `assignee = currentUser() AND status = "To Do" AND resolution = EMPTY ORDER BY updated DESC`

// jiraIssues is the whole answer of GET /api/jira/issues.
type jiraIssues struct {
	OK        bool         `json:"ok"`
	FetchedAt time.Time    `json:"fetchedAt"`
	Planning  []jira.Issue `json:"planning"`
	Todo      []jira.Issue `json:"todo"`
	// Error is a short reason the lists are empty (acli not logged in,
	// SLASH_JIRA=off, …). The UI shows the sections as simply absent rather
	// than as an error wall — same "never cry wolf" rule as the bell feed.
	Error string `json:"error,omitempty"`
}

var (
	jiraIssuesMu     sync.Mutex
	jiraIssuesCache  *jiraIssues
	jiraIssuesCached time.Time
)

// handleJiraIssues serves GET /api/jira/issues[?refresh=1] — read-only.
func (s *server) handleJiraIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	force := r.URL.Query().Get("refresh") == "1"

	jiraIssuesMu.Lock()
	if !force && jiraIssuesCache != nil && time.Since(jiraIssuesCached) < jiraIssuesTTL {
		cached := *jiraIssuesCache
		jiraIssuesMu.Unlock()
		writeJSON(w, http.StatusOK, cached)
		return
	}
	jiraIssuesMu.Unlock()

	var cl jira.Client
	if s.tasks != nil && s.tasks.manager != nil {
		cl = s.tasks.manager.jira
	}
	// Deliberately NOT r.Context(), for the same reason as handleAuthStatus:
	// the result is cached and shared across tabs, so a reviewer refreshing
	// mid-flight must not kill the acli subprocess and poison the cache. Each
	// search still carries the module's own bounded timeout.
	out := fetchJiraIssues(context.Background(), cl)

	jiraIssuesMu.Lock()
	if out.Error == "" {
		jiraIssuesCache = &out
		jiraIssuesCached = time.Now()
	}
	jiraIssuesMu.Unlock()
	writeJSON(w, http.StatusOK, out)
}

// fetchJiraIssues runs both searches. A failing search yields an empty list
// plus a reason, never an HTTP error: the overview treats "no issues" and "Jira
// unreachable" the same way (no section), and the real credential problem is
// already reported by GET /api/auth/status.
func fetchJiraIssues(ctx context.Context, cl jira.Client) jiraIssues {
	out := jiraIssues{OK: true, FetchedAt: time.Now(), Planning: []jira.Issue{}, Todo: []jira.Issue{}}
	if os.Getenv("SLASH_JIRA") == "off" {
		out.Error = "SLASH_JIRA=off"
		return out
	}
	if cl == nil {
		out.Error = "jira client unavailable"
		return out
	}
	planning, err := cl.Search(ctx, planningJQL, jiraIssuesLimit)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	todo, err := cl.Search(ctx, todoJQL, jiraIssuesLimit)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Planning = append(out.Planning, planning...)
	// An issue that is both To Do and in the active sprint is already being
	// planned, so it is shown once, in the section furthest along the pipeline.
	inPlanning := map[string]bool{}
	for _, is := range planning {
		inPlanning[is.Key] = true
	}
	for _, is := range todo {
		if !inPlanning[is.Key] {
			out.Todo = append(out.Todo, is)
		}
	}
	return out
}
