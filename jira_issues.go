package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/jira"
	"slash/modules/jiraissues"
)

// jira_issues.go serves the two ISSUE sections of the PR overview — the work
// that comes BEFORE a pull request exists. The page reads top to bottom as one
// pipeline: "Needs your review" (a PR waiting for you), then "Planning" (what
// is in the active sprint), then "Todo" (what is still queued). See
// .claude/docs/pr-overview.md.
//
// SHAPE: a tracker + read-model, exactly like the Jira bell feed next door
// (jira_notifications.go). The `jira_issues` Workflow below owns the fetching —
// ONE Execution for the whole process, since these issues are the reviewer's
// own (`assignee = currentUser()`) and thus per-USER, not per-repo — and writes
// both lists into the jiraissues read-model; GET /api/jira/issues only READS
// that snapshot. Per .claude/rules/workflows-write-boundary.md the module's
// write method is therefore reachable only from this workflow's Activity.
//
// This used to be an on-demand fetch behind a 5-minute in-memory cache. It was
// changed on request ("lijst met jira dingen moet je in workflows bijwerken.
// dan kan ik sneller navigeren"): a cold call was measured at ~36s because of
// groupPlanning's extra per-issue parent reads, and after a restart the cache
// was empty again, so the first visit to /pr-overview paid that price in full.
// With the tracker the page always finds a snapshot lying ready.
//
// Deliberately its OWN Workflow Type rather than another `kind` on the
// jira_inbox tracker's Signal: Engine.SignalWorkflow drives a Signal INLINE
// under that run's own lock, so a slow issues refresh sharing the run would
// block the bell's "mark as read" for as long as it takes. Two runs, two locks.

// jiraIssuesInterval is the poll cadence — the same 5 minutes the old cache
// TTL used, and the same as the notification feed's. Every tick costs real
// `acli` subprocesses, so it stays a fixed ticker rather than a heartbeat.
const jiraIssuesInterval = 5 * time.Minute

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

// jiraIssues is one fetch's outcome, on its way into the read-model.
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

// jiraIssuesResponse is the whole answer of GET /api/jira/issues — the stored
// snapshot, in the exact JSON shape the overview already reads (the lists pass
// through as the opaque JSON the read-model holds, so the row shape lives in
// one place: planningRow/jira.Issue above). FetchedAt is the moment of the
// refresh that produced it, not of this request.
type jiraIssuesResponse struct {
	OK        bool            `json:"ok"`
	FetchedAt string          `json:"fetchedAt"`
	Planning  json.RawMessage `json:"planning"`
	Todo      json.RawMessage `json:"todo"`
	Error     string          `json:"error,omitempty"`
}

// JiraIssuesInput starts the single jira_issues Execution.
type JiraIssuesInput struct{}

// JiraIssuesSignal is the one Signal payload the tracker reacts to. Only
// "refresh" exists today; the field is there so a later action can be added
// without a second Signal name, the same way JiraNotifySignal carries three.
type JiraIssuesSignal struct {
	Kind string `json:"kind"`
}

// jiraIssuesResult is the small summary the refresh Activity returns, so the
// endlessly-refreshing history stays compact. A FETCH FAILURE is reported in
// here rather than returned as an error: acli not being logged in must not
// fail the tracker permanently — it would then never poll again until a
// restart. Same reasoning as jiraNotifyResult.
type jiraIssuesResult struct {
	Planning int    `json:"planning"`
	Todo     int    `json:"todo"`
	Error    string `json:"error,omitempty"`
}

// jiraIssuesWorkflow owns both issue lists. Deterministic: one Signal per loop
// iteration and a branch that reads only that Signal's recorded payload. It
// never completes — a long-lived tracker.
func jiraIssuesWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	for {
		var sig JiraIssuesSignal
		w.WaitSignal(SignalJiraIssues, &sig)
		var res jiraIssuesResult
		if err := w.ExecuteActivity("refreshJiraIssues", JiraIssuesInput{}, &res); err != nil {
			return nil, fmt.Errorf("refresh jira issues: %w", err)
		}
	}
}

// registerJiraIssuesActivities wires the one Activity. Called from
// registerWorkflows in workflows.go.
func (m *TaskManager) registerJiraIssuesActivities(engine *tembed.Engine) {
	// The jiraissues module is the only writer of this read-model.
	engine.RegisterActivity("refreshJiraIssues", func(ctx context.Context, in []byte) ([]byte, error) {
		return json.Marshal(m.refreshJiraIssues(ctx))
	})
}

// refreshJiraIssues runs both searches plus the grouping and stores the
// result. Like refreshJiraNotifications it never returns an error; a failure
// is recorded on the result and stored with the snapshot, so the endpoint can
// say why the sections are empty.
func (m *TaskManager) refreshJiraIssues(ctx context.Context) jiraIssuesResult {
	out := fetchJiraIssues(ctx, m.jira)
	res := jiraIssuesResult{Planning: len(out.Planning), Todo: len(out.Todo), Error: out.Error}
	if m.jiraissues == nil {
		return res
	}
	planning, err := json.Marshal(out.Planning)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	todo, err := json.Marshal(out.Todo)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	// A failed fetch keeps whatever was stored before — an acli hiccup must
	// not blank a perfectly usable list. Only the reason is refreshed.
	if out.Error != "" {
		if prev, err := m.jiraissues.Get(ctx); err == nil && prev != nil {
			prev.Error = out.Error
			if err := m.jiraissues.Save(ctx, *prev); err != nil {
				res.Error = err.Error()
			}
			return res
		}
	}
	if err := m.jiraissues.Save(ctx, jiraissues.Snapshot{
		UpdatedAt: out.FetchedAt.UTC().Format(time.RFC3339),
		Planning:  planning,
		Todo:      todo,
		Error:     out.Error,
	}); err != nil {
		res.Error = err.Error()
	}
	return res
}

// EnsureJiraIssues starts (or reuses) the single jira_issues Execution.
// Mirrors EnsureJiraInbox; idempotent across restarts.
func (m *TaskManager) EnsureJiraIssues(ctx context.Context) string {
	m.mu.Lock()
	runID := m.jiraIssuesRun
	if runID == "" {
		runID = m.findJiraIssuesRunLocked()
	}
	m.mu.Unlock()

	if runID == "" {
		id, err := m.engine.StartWorkflow(WorkflowJiraIssues, JiraIssuesInput{})
		if err != nil {
			m.logf("jira_issues: start: %v", err)
			return ""
		}
		runID = id
	}
	m.mu.Lock()
	m.jiraIssuesRun = runID
	m.mu.Unlock()
	return runID
}

// StartJiraIssuesPolling runs the initial refresh and the poller behind the
// ready gate, so the startup burst never delays the HTTP listener binding.
func (m *TaskManager) StartJiraIssuesPolling(ctx context.Context) {
	runID := m.EnsureJiraIssues(ctx)
	if runID == "" {
		return
	}
	go func() {
		m.waitReady()
		m.signalJiraIssues(runID, JiraIssuesSignal{Kind: "refresh"})
		m.pollJiraIssues(ctx, runID)
	}()
}

// pollJiraIssues signals a refresh every jiraIssuesInterval. It never stops on
// its own — only when the context is cancelled or the run is gone.
func (m *TaskManager) pollJiraIssues(ctx context.Context, runID string) {
	ticker := time.NewTicker(jiraIssuesInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		status, err := m.engine.Status(runID)
		if err != nil || status == tembed.StatusFailed || status == tembed.StatusCompleted {
			return
		}
		m.signalJiraIssues(runID, JiraIssuesSignal{Kind: "refresh"})
	}
}

// signalJiraIssues delivers one Signal, logging (never returning) a failure —
// the poller must survive a bad tick.
func (m *TaskManager) signalJiraIssues(runID string, sig JiraIssuesSignal) {
	payload, err := json.Marshal(sig)
	if err != nil {
		m.logf("jira_issues: marshal signal: %v", err)
		return
	}
	if err := m.engine.SignalWorkflow(runID, SignalJiraIssues, json.RawMessage(payload)); err != nil {
		m.logf("jira_issues: signal %s run=%s: %v", sig.Kind, runID, err)
	}
}

// findJiraIssuesRunLocked scans for a running/waiting jira_issues Execution.
func (m *TaskManager) findJiraIssuesRunLocked() string {
	runs, err := m.engine.Runs()
	if err != nil {
		return ""
	}
	for _, r := range runs {
		if r.Workflow != WorkflowJiraIssues {
			continue
		}
		if r.Status == tembed.StatusRunning || r.Status == tembed.StatusWaiting {
			return r.ID
		}
	}
	return ""
}

// JiraIssuesSnapshot returns the stored snapshot. READ-only.
func (m *TaskManager) JiraIssuesSnapshot(ctx context.Context) (*jiraissues.Snapshot, error) {
	if m.jiraissues == nil {
		return nil, nil
	}
	return m.jiraissues.Get(ctx)
}

// handleJiraIssues serves GET /api/jira/issues[?refresh=1] — read-only. It
// answers straight from the read-model, so it costs one SQLite row read no
// matter how slow Jira is. ?refresh=1 asks the tracker for a fresh fetch IN
// THE BACKGROUND and still answers with the current snapshot: signalling
// inline would make the request wait for the whole (measured ~36s) fetch,
// which is exactly what this tracker exists to avoid.
func (s *server) handleJiraIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var mgr *TaskManager
	if s.tasks != nil {
		mgr = s.tasks.manager
	}
	out := jiraIssuesResponse{OK: true, Planning: json.RawMessage("[]"), Todo: json.RawMessage("[]")}
	if mgr == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	if r.URL.Query().Get("refresh") == "1" {
		if runID := mgr.EnsureJiraIssues(r.Context()); runID != "" {
			go mgr.signalJiraIssues(runID, JiraIssuesSignal{Kind: "refresh"})
		}
	}
	snap, err := mgr.JiraIssuesSnapshot(r.Context())
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if snap != nil {
		out.FetchedAt = snap.UpdatedAt
		out.Error = snap.Error
		if len(snap.Planning) > 0 {
			out.Planning = snap.Planning
		}
		if len(snap.Todo) > 0 {
			out.Todo = snap.Todo
		}
	}
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
