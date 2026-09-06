package main

import (
	"context"
	"net/http"
	"os"
	"strings"
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
// planningJQL is what you still have to DO in the active sprint: assigned to
// you, most recently updated first, minus the two stages that are no longer
// planning ("hier niet in review laten zien en niet done"). `statusCategory !=
// Done` rather than `status != "Done"` so every finished status (Closed,
// Resolved, …) drops out, not just the one literally named "Done"; "In Review"
// is an ordinary in-progress status name and therefore needs its own clause.
const planningJQL = `assignee = currentUser() AND sprint in openSprints() AND statusCategory != Done AND status != "In Review" ORDER BY updated DESC`

// todoJQL is the queue feeding that sprint: still To Do, still unresolved.
const todoJQL = `assignee = currentUser() AND status = "To Do" AND resolution = EMPTY ORDER BY updated DESC`

// jiraIssueReadsMax bounds how many extra per-issue reads one grouping round
// may do, and jiraIssueReadsPar how many run at a time. Each is its own `acli
// jira workitem view` of several seconds, so an unusual sprint full of orphan
// Sub-tasks can never turn one refresh into a minutes-long crawl.
const (
	jiraIssueReadsMax = 12
	jiraIssueReadsPar = 4
)

// planningRow is one row of the Planning section: an issue plus the single bit
// the grouping adds. Context marks a row that is only there to NAME the main
// task a Sub-task of yours hangs under — it is not your work (it may not even
// be in the sprint), so the UI renders it as an unclickable header rather than
// as a row you can open. Everything else about the row is the issue itself,
// embedded so the JSON keeps the exact shape the frontend already reads.
type planningRow struct {
	jira.Issue
	Context bool `json:"context,omitempty"`
}

// jiraIssues is the whole answer of GET /api/jira/issues.
type jiraIssues struct {
	OK        bool          `json:"ok"`
	FetchedAt time.Time     `json:"fetchedAt"`
	Planning  []planningRow `json:"planning"`
	Todo      []jira.Issue  `json:"todo"`
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
	out := jiraIssues{OK: true, FetchedAt: time.Now(), Planning: []planningRow{}, Todo: []jira.Issue{}}
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
	out.Planning = append(out.Planning, groupPlanning(ctx, cl, planning)...)
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

// groupPlanning reorders the Planning rows so a Sub-task sits directly under
// the main task it belongs to, instead of floating somewhere else in the
// "updated DESC" order. A group is placed at the position of its EARLIEST
// member, so the sprint's own recency ordering still drives the page.
//
// A Sub-task whose parent is not in the list gets that parent pulled in as a
// CONTEXT row (Reindert: the main task must be shown above its subtasks "ook
// als die hoofdtaak niet van hem is of buiten de sprint valt"). Both halves
// need per-issue reads, because the search cannot return a parent at all (see
// modules/jira/search.go), so this costs up to two rounds of `acli jira
// workitem view` — bounded, concurrent, and behind the endpoint's own 5-minute
// cache, so they happen once per refresh rather than once per page load. A
// parent that cannot be read simply does not appear; the Sub-task then stays
// an ordinary top-level row and nothing else changes.
func groupPlanning(ctx context.Context, cl jira.Client, list []jira.Issue) []planningRow {
	// Round 1: learn each Sub-task's own parent.
	var want []string
	for _, is := range list {
		if isSubtask(is) && is.ParentKey == "" {
			want = append(want, is.Key)
		}
	}
	read := readIssues(ctx, cl, want)
	rows := make([]jira.Issue, len(list))
	copy(rows, list)
	for i, is := range rows {
		if full, ok := read[is.Key]; ok {
			rows[i].ParentKey, rows[i].ParentTitle = full.ParentKey, full.ParentTitle
		}
	}

	var order []string                    // group head keys, in output order
	heads := map[string]jira.Issue{}      // head key -> its own row, when it is in the list
	children := map[string][]jira.Issue{} // head key -> its Sub-tasks, in list order
	titles := map[string]string{}         // head key -> the title its child knows it by
	seen := map[string]bool{}
	place := func(key string) {
		if !seen[key] {
			seen[key] = true
			order = append(order, key)
		}
	}
	for _, is := range rows {
		if is.ParentKey == "" || is.ParentKey == is.Key {
			place(is.Key)
			heads[is.Key] = is
			continue
		}
		children[is.ParentKey] = append(children[is.ParentKey], is)
		if titles[is.ParentKey] == "" {
			titles[is.ParentKey] = is.ParentTitle
		}
		place(is.ParentKey)
	}

	// Round 2: read the parents that are not in the list themselves.
	want = want[:0]
	for _, key := range order {
		if _, ok := heads[key]; !ok {
			want = append(want, key)
		}
	}
	parents := readIssues(ctx, cl, want)

	out := make([]planningRow, 0, len(rows)+len(want))
	for _, key := range order {
		if head, ok := heads[key]; ok {
			out = append(out, planningRow{Issue: head})
		} else if parent, ok := parents[key]; ok {
			if parent.Title == "" {
				parent.Title = titles[key]
			}
			// The row only ever shows key/title/type; a full ADF description
			// would otherwise travel to the browser for nothing.
			parent.Description = ""
			parent.Subtasks = nil
			// A context row is a group HEAD here, whatever it hangs under in
			// Jira itself — keeping its own parent would let the frontend
			// indent it under an unrelated row that happens to be in the list.
			parent.ParentKey, parent.ParentTitle = "", ""
			out = append(out, planningRow{Issue: parent, Context: true})
		}
		for _, c := range children[key] {
			out = append(out, planningRow{Issue: c})
		}
	}
	return out
}

// isSubtask decides which rows are worth a parent lookup. Jira spells the type
// differently per site and language ("Sub-task", "Subtask", "Sub-taak"), so
// this matches the prefix rather than one exact name — a wrong guess only ever
// costs one extra read that comes back without a parent.
func isSubtask(is jira.Issue) bool {
	return strings.HasPrefix(strings.ToLower(is.Type), "sub")
}

// readIssues reads the given keys through cl.Issue, at most jiraIssueReadsMax
// of them and at most jiraIssueReadsPar at a time. Each `acli jira workitem
// view` takes seconds, so doing them one after another would make a cache miss
// visibly slow; the cap is what keeps an unusual sprint from turning one
// refresh into a long crawl. A key that fails to read is simply absent from
// the result — this whole enrichment is best-effort.
func readIssues(ctx context.Context, cl jira.Client, keys []string) map[string]jira.Issue {
	out := map[string]jira.Issue{}
	if cl == nil || len(keys) == 0 {
		return out
	}
	if len(keys) > jiraIssueReadsMax {
		keys = keys[:jiraIssueReadsMax]
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, jiraIssueReadsPar)
	for _, key := range keys {
		wg.Add(1)
		go func(key string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			is, err := cl.Issue(ctx, key)
			if err != nil || is.Key == "" {
				return
			}
			mu.Lock()
			out[key] = is
			mu.Unlock()
		}(key)
	}
	wg.Wait()
	return out
}
