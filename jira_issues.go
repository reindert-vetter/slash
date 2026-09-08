package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/jira"
	"slash/modules/jiraissues"
)

// jira_issues.go serves the ISSUE section of the PR overview — the work that
// comes BEFORE a pull request exists. The page reads top to bottom as one
// pipeline: "Needs your review" (a PR waiting for you), then this one list of
// your own sprint work. See .claude/docs/pr-overview.md.
//
// It used to be TWO sections, "Planning" and "Todo". They were merged on
// request ("bij nader inzien, gooi todo en planning bij elkaar, maar dan todo
// items onder de planning items (als er een groep is, met verschillende
// statussen, gooi ze boven todo)") into one list with two LANES: the planning
// lane (what you are working on right now) above the todo lane (what is queued
// in the same sprint). A GROUP — a main task with its subtasks — carries the
// planning lane as soon as ANY of its own members is in it, so a group with
// mixed statuses lands above the plain todo rows. See groupIssues.
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
// groupIssues's extra per-issue parent reads, and after a restart the cache
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

// The two JQL queries behind the two LANES of the one list. Both are
// CONSTANTS — no reviewer input ever reaches acli (see modules/jira/search.go).
//
// Both are scoped to `assignee = currentUser()`, which is also what makes
// "laat alleen subtaken zien die op mijn naam staan" hold: every row of either
// lane is the reviewer's own work by construction. The one row that is NOT is
// a main task pulled in as CONTEXT (see groupIssues) — it is marked as such,
// is not a link, and is not counted.
//
// planningJQL is what you are working on right now: "planning; moet alle in
// progress stories zijn". Deliberately the status NAME rather than
// `statusCategory = "In Progress"`, which would also drag "In Review" back in
// — a stage the reviewer explicitly does not want here ("hier niet in review
// laten zien en niet done"). Its predecessor was every non-Done sprint status,
// which is why a To Do sprint issue used to sit in this lane.
const planningJQL = `assignee = currentUser() AND (sprint in openSprints() OR sprint in futureSprints()) AND status = "In Progress" ORDER BY updated DESC`

// todoJQL is the queue feeding that same sprint: still To Do, still
// unresolved — "todo, alleen todo". `sprint in openSprints()` was added with
// the merge ("ik wil in todo en in planning alleen items zien uit active
// sprints"): the lane used to be the whole backlog queue, sprint or not.
const todoJQL = `assignee = currentUser() AND (sprint in openSprints() OR sprint in futureSprints()) AND status = "To Do" AND resolution = EMPTY ORDER BY updated DESC`

// `futureSprints()` sits next to `openSprints()` in BOTH queries on request
// ("laat ook van andere sprints zien wat ik dan als extra blok daaronder zie
// (ook al zijn die niet actief)"): a ticket already planned into a NEXT sprint
// is shown too, in its own block below the active one. Which block a row lands
// in is decided by its own sprint, read per issue (see sprintBuckets) — the
// board is never pinned down anywhere, so "alles waar ik assigned items in
// heb" holds by construction.

// jiraInProgressStatus is the Jira status the plan tracker moves a ticket to
// once the reviewer answered which branch it goes out from — the very status
// planningJQL above selects on, so the row climbs into the planning lane by
// the same rule everything else in it got there (see jiraStartProgress in
// plan_workflow.go).
const jiraInProgressStatus = "In Progress"

// The two lanes of the one list, in render order. A row carries its own lane
// (its own status decides it); a GROUP carries the earliest lane of any of its
// members, which is what puts a mixed-status group above the todo rows.
const (
	lanePlanning = "planning"
	laneTodo     = "todo"
)

// jiraIssueReadsMax bounds how many extra per-issue reads one grouping round
// may do, and jiraIssueReadsPar how many run at a time. Each is its own `acli
// jira workitem view` of several seconds, so an unusual sprint full of orphan
// Sub-tasks can never turn one refresh into a minutes-long crawl. The cap grew
// from 12 to 20 when the two sections merged: one round now walks the Sub-tasks
// of BOTH lanes, and a Sub-task whose parent read is skipped is exactly the row
// that ends up without the parent the reviewer asked to always see.
const (
	jiraIssueReadsMax = 20
	jiraIssueReadsPar = 4
)

// issueRow is one row of the list: an issue plus the two bits the grouping
// adds. Context marks a row that is only there to NAME the main task a
// Sub-task of yours hangs under — it is not your work (it may not even be in
// the sprint), so the UI renders it as an unclickable header rather than as a
// row you can open. Lane is which half of the pipeline the row itself belongs
// to, so the frontend can keep rendering one flat list while the two lanes
// stay tellable apart. Everything else about the row is the issue itself,
// embedded so the JSON stays one flat object per row.
type issueRow struct {
	jira.Issue
	Context bool   `json:"context,omitempty"`
	Lane    string `json:"lane,omitempty"`
	// Sprint is the NAME of the sprint block this row is rendered under
	// ("Team Core Sprint 71"), empty for a row that is in no sprint at all.
	// The frontend cuts the one flat list into sections wherever this value
	// changes, so the block ORDER stays the backend's (see sprintBuckets).
	// A context row inherits the sprint of the group it heads, which is why
	// this is set per BUCKET rather than per issue.
	Sprint string `json:"sprint,omitempty"`
}

// jiraIssues is one fetch's outcome, on its way into the read-model.
type jiraIssues struct {
	OK        bool       `json:"ok"`
	FetchedAt time.Time  `json:"fetchedAt"`
	Issues    []issueRow `json:"issues"`
	// Error is a short reason the list is empty (acli not logged in,
	// SLASH_JIRA=off, …). The UI shows the section as simply absent rather
	// than as an error wall — same "never cry wolf" rule as the bell feed.
	Error string `json:"error,omitempty"`
}

// jiraIssuesResponse is the whole answer of GET /api/jira/issues — the stored
// snapshot, in the exact JSON shape the overview reads (the list passes
// through as the opaque JSON the read-model holds, so the row shape lives in
// one place: issueRow above). FetchedAt is the moment of the refresh that
// produced it, not of this request.
type jiraIssuesResponse struct {
	OK        bool            `json:"ok"`
	FetchedAt string          `json:"fetchedAt"`
	Issues    json.RawMessage `json:"issues"`
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
	Issues int    `json:"issues"`
	Error  string `json:"error,omitempty"`
}

// jiraIssuesWorkflow owns the issue list. Deterministic: one Signal per loop
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
	res := jiraIssuesResult{Issues: len(out.Issues), Error: out.Error}
	if m.jiraissues == nil {
		return res
	}
	issues, err := json.Marshal(out.Issues)
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
		Issues:    issues,
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
	out := jiraIssuesResponse{OK: true, Issues: json.RawMessage("[]")}
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
		if len(snap.Issues) > 0 {
			out.Issues = snap.Issues
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// fetchJiraIssues runs both searches and folds them into the ONE list the
// page renders. A failing search yields an empty list plus a reason, never an
// HTTP error: the overview treats "no issues" and "Jira unreachable" the same
// way (no section), and the real credential problem is already reported by
// GET /api/auth/status.
func fetchJiraIssues(ctx context.Context, cl jira.Client) jiraIssues {
	out := jiraIssues{OK: true, FetchedAt: time.Now(), Issues: []issueRow{}}
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
	// The two JQL queries are disjoint on status today, but an issue that
	// somehow matches both belongs in the lane furthest along the pipeline —
	// it is already being worked on, so it is shown once, in planning.
	inPlanning := map[string]bool{}
	for _, is := range planning {
		inPlanning[is.Key] = true
	}
	queued := make([]jira.Issue, 0, len(todo))
	for _, is := range todo {
		if !inPlanning[is.Key] {
			queued = append(queued, is)
		}
	}
	// One block per sprint, in sprint order; the grouping itself runs per
	// block so lanes, Sub-task nesting and context rows behave inside a block
	// exactly as they did when there was only one.
	for _, b := range sprintBuckets(ctx, cl, planning, queued) {
		rows := groupIssues(ctx, cl, b.planning, b.todo)
		for i := range rows {
			rows[i].Sprint = b.name
		}
		out.Issues = append(out.Issues, rows...)
	}
	return out
}

// jiraSprintReads bounds the per-issue sprint reads of ONE refresh, the same
// way jiraIssueReadsMax/Par bound the parent reads: each is its own `acli jira
// workitem view` of a few seconds. Slightly wider than the parent cap because
// EVERY row needs one (a parent read is only for Sub-tasks), and a bit more
// parallel so a full sprint still costs seconds rather than a minute.
const (
	jiraSprintReadsMax = 40
	jiraSprintReadsPar = 6
)

// sprintBucket is one rendered block: a sprint (or, with an empty name, the
// rows that are in no sprint at all) plus its own two lanes.
type sprintBucket struct {
	name     string
	sprint   jira.Sprint
	planning []jira.Issue
	todo     []jira.Issue
}

// sprintBuckets splits both lanes into one bucket per sprint. Order —
// deliberately decided HERE rather than in the frontend, like every other
// ordering rule of this list:
//
//  1. active sprints first, oldest start first (normally there is exactly one,
//     but a reviewer working across boards can genuinely have several);
//  2. then the FUTURE sprints, again by start date, so the next sprint sits
//     directly under the one being worked on;
//  3. finally, the rows that are in no sprint at all, in a nameless block —
//     they would otherwise silently disappear from the page.
//
// A closed sprint never forms a block: an issue that also sits in one (every
// issue that moved sprints does) is placed by pickSprint below.
func sprintBuckets(ctx context.Context, cl jira.Client, planning, todo []jira.Issue) []sprintBucket {
	keys := make([]string, 0, len(planning)+len(todo))
	for _, is := range planning {
		keys = append(keys, is.Key)
	}
	for _, is := range todo {
		keys = append(keys, is.Key)
	}
	byKey := readSprints(ctx, cl, keys)

	order := []string{}
	buckets := map[string]*sprintBucket{}
	add := func(is jira.Issue, lane string) {
		sp := pickSprint(byKey[is.Key])
		b, ok := buckets[sp.Name]
		if !ok {
			b = &sprintBucket{name: sp.Name, sprint: sp}
			buckets[sp.Name] = b
			order = append(order, sp.Name)
		}
		if lane == lanePlanning {
			b.planning = append(b.planning, is)
		} else {
			b.todo = append(b.todo, is)
		}
	}
	for _, is := range planning {
		add(is, lanePlanning)
	}
	for _, is := range todo {
		add(is, laneTodo)
	}

	sort.SliceStable(order, func(i, j int) bool {
		return sprintBefore(buckets[order[i]].sprint, buckets[order[j]].sprint)
	})
	out := make([]sprintBucket, 0, len(order))
	for _, name := range order {
		out = append(out, *buckets[name])
	}
	return out
}

// sprintBefore is rule 1-3 of sprintBuckets as one comparison: a sprintless
// bucket last, an active sprint before a future one, and within a state the
// earliest start first (falling back to the name, so the order is stable for a
// sprint without a start date).
func sprintBefore(a, b jira.Sprint) bool {
	rank := func(sp jira.Sprint) int {
		switch {
		case sp.Name == "":
			return 2
		case sp.State == sprintStateActive:
			return 0
		default:
			return 1
		}
	}
	if ra, rb := rank(a), rank(b); ra != rb {
		return ra < rb
	}
	if a.StartDate != b.StartDate {
		return a.StartDate < b.StartDate
	}
	return a.Name < b.Name
}

// The two sprint states this list renders a block for. Jira also has
// "closed", which never gets one.
const (
	sprintStateActive = "active"
	sprintStateFuture = "future"
)

// pickSprint decides which of an issue's sprints it is SHOWN under. An issue
// that has moved carries every sprint it was ever in, so: the active one
// wins (that is where the work is happening), otherwise the earliest future
// one (where it is planned to happen), and a purely closed history counts as
// no sprint at all rather than as a block of its own.
func pickSprint(list []jira.Sprint) jira.Sprint {
	var best jira.Sprint
	for _, sp := range list {
		if sp.Name == "" || (sp.State != sprintStateActive && sp.State != sprintStateFuture) {
			continue
		}
		if best.Name == "" || sprintBefore(sp, best) {
			best = sp
		}
	}
	return best
}

// readSprints reads the sprints of the given keys, at most jiraSprintReadsMax
// of them and jiraSprintReadsPar at a time — same best-effort, bounded shape
// as readIssues below: a key that fails to read is simply absent, and its row
// then lands in the nameless block instead of disappearing.
func readSprints(ctx context.Context, cl jira.Client, keys []string) map[string][]jira.Sprint {
	out := map[string][]jira.Sprint{}
	if cl == nil || len(keys) == 0 {
		return out
	}
	if len(keys) > jiraSprintReadsMax {
		keys = keys[:jiraSprintReadsMax]
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, jiraSprintReadsPar)
	for _, key := range keys {
		wg.Add(1)
		go func(key string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			list, err := cl.IssueSprints(ctx, key)
			if err != nil || len(list) == 0 {
				return
			}
			mu.Lock()
			out[key] = list
			mu.Unlock()
		}(key)
	}
	wg.Wait()
	return out
}

// groupIssues folds the two lanes into one ordered list. Three rules, in this
// order:
//
//  1. A Sub-task sits directly under the main task it belongs to, instead of
//     floating somewhere else in the "updated DESC" order. A main task that is
//     not in either list itself is pulled in as a CONTEXT row (Reindert: the
//     main task must be shown above its subtasks "ook als die hoofdtaak niet
//     van hem is of buiten de sprint valt").
//  2. A GROUP's lane is the planning lane as soon as ANY of its own members is
//     in it — "als er een groep is, met verschillende statussen, gooi ze boven
//     todo". A lone row is a group of one, so its own lane decides.
//  3. Every planning-lane group comes before every todo-lane group; WITHIN a
//     lane a group sits at the position of its EARLIEST member, so Jira's own
//     recency ordering still drives the page.
//
// Rule 1 needs per-issue reads, because the search cannot return a parent at
// all (see modules/jira/search.go): two rounds of `acli jira workitem view` —
// bounded, concurrent, and inside the tracker's own refresh, so they cost once
// per 5-minute tick rather than once per page load. A parent that cannot be
// read simply does not appear; the Sub-task then stays an ordinary top-level
// row and names its parent by KEY on its own meta line instead (the frontend
// does that from ParentKey, which round 1 filled in).
func groupIssues(ctx context.Context, cl jira.Client, planning, todo []jira.Issue) []issueRow {
	// One merged sequence, planning first, each row remembering its own lane.
	merged := make([]issueRow, 0, len(planning)+len(todo))
	for _, is := range planning {
		merged = append(merged, issueRow{Issue: is, Lane: lanePlanning})
	}
	for _, is := range todo {
		merged = append(merged, issueRow{Issue: is, Lane: laneTodo})
	}

	// Round 1: learn each Sub-task's own parent.
	var want []string
	for _, r := range merged {
		if isSubtask(r.Issue) && r.ParentKey == "" {
			want = append(want, r.Key)
		}
	}
	read := readIssues(ctx, cl, want)
	for i := range merged {
		if full, ok := read[merged[i].Key]; ok {
			merged[i].ParentKey, merged[i].ParentTitle = full.ParentKey, full.ParentTitle
		}
	}

	var order []string                  // group head keys, in encounter order
	heads := map[string]issueRow{}      // head key -> its own row, when it is in the list
	children := map[string][]issueRow{} // head key -> its Sub-tasks, in list order
	titles := map[string]string{}       // head key -> the title its child knows it by
	lanes := map[string]string{}        // head key -> the GROUP's lane (rule 2)
	seen := map[string]bool{}
	place := func(key, lane string) {
		if !seen[key] {
			seen[key] = true
			order = append(order, key)
		}
		if lane == lanePlanning || lanes[key] == "" {
			lanes[key] = lane
		}
	}
	for _, r := range merged {
		if r.ParentKey == "" || r.ParentKey == r.Key {
			place(r.Key, r.Lane)
			heads[r.Key] = r
			continue
		}
		children[r.ParentKey] = append(children[r.ParentKey], r)
		if titles[r.ParentKey] == "" {
			titles[r.ParentKey] = r.ParentTitle
		}
		place(r.ParentKey, r.Lane)
	}

	// Round 2: read the parents that are not in either list themselves.
	want = want[:0]
	for _, key := range order {
		if _, ok := heads[key]; !ok {
			want = append(want, key)
		}
	}
	parents := readIssues(ctx, cl, want)

	out := make([]issueRow, 0, len(merged)+len(want))
	// Rule 3: the planning lane first, then the todo lane, each in `order`.
	for _, lane := range []string{lanePlanning, laneTodo} {
		for _, key := range order {
			if lanes[key] != lane {
				continue
			}
			if head, ok := heads[key]; ok {
				out = append(out, head)
			} else if parent, ok := parents[key]; ok {
				if parent.Title == "" {
					parent.Title = titles[key]
				}
				// The row only ever shows key/title/type; a full ADF
				// description or the ticket's comments would otherwise travel
				// to the browser for nothing.
				parent.Description = ""
				parent.Comments = nil
				parent.Subtasks = nil
				// A context row is a group HEAD here, whatever it hangs under
				// in Jira itself — keeping its own parent would let the
				// frontend indent it under an unrelated row that happens to
				// be in the list.
				parent.ParentKey, parent.ParentTitle = "", ""
				out = append(out, issueRow{Issue: parent, Context: true, Lane: lane})
			}
			out = append(out, children[key]...)
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
