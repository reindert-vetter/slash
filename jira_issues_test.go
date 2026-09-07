package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/jira"
	"slash/modules/jiraissues"
)

// keysOf is the readable form of a row list for the assertions below.
func keysOf(rows []issueRow) []string {
	var out []string
	for _, r := range rows {
		out = append(out, r.Key)
	}
	return out
}

// sameKeys compares a row list against the exact order wanted.
func sameKeys(rows []issueRow, want ...string) bool {
	got := keysOf(rows)
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// TestIssueJQLScopesBothLanes pins the FILTER rule of the merged list, which is
// entirely carried by two constants: both lanes are the reviewer's own work
// ("laat alleen subtaken zien die op mijn naam staan" — every row of either
// lane is assignee = currentUser() by construction) in an ACTIVE sprint ("ik
// wil in todo en in planning alleen items zien uit active sprints"), the
// planning lane is In Progress ("planning; moet alle in progress stories
// zijn") and the todo lane is To Do only ("todo, alleen todo").
func TestIssueJQLScopesBothLanes(t *testing.T) {
	for _, jql := range []string{planningJQL, todoJQL} {
		for _, want := range []string{"assignee = currentUser()", "sprint in openSprints()"} {
			if !strings.Contains(jql, want) {
				t.Fatalf("jql %q is missing %q", jql, want)
			}
		}
	}
	if !strings.Contains(planningJQL, `status = "In Progress"`) {
		t.Fatalf("planningJQL = %q, want only In Progress", planningJQL)
	}
	if !strings.Contains(todoJQL, `status = "To Do"`) {
		t.Fatalf("todoJQL = %q, want only To Do", todoJQL)
	}
	// The status the plan tracker transitions a ticket to is exactly the one
	// the planning lane selects on, so answering the branch question really
	// does move the row up (see startJiraProgress).
	if !strings.Contains(planningJQL, jiraInProgressStatus) {
		t.Fatalf("planningJQL = %q, want the status startJiraProgress sets (%q)", planningJQL, jiraInProgressStatus)
	}
}

// TestFetchJiraIssuesPutsThePlanningLaneFirst — the two searches become ONE
// list: everything In Progress above everything still To Do, each lane in its
// own "updated DESC" order, and every row carrying which lane it came from.
func TestFetchJiraIssuesPutsThePlanningLaneFirst(t *testing.T) {
	t.Setenv("SLASH_JIRA", "")
	f := &jira.Fake{}
	f.SetSearch(planningJQL, []jira.Issue{{Key: "INTEG-445", Status: "In Progress"}, {Key: "BUG-5195", Status: "In Progress"}})
	f.SetSearch(todoJQL, []jira.Issue{{Key: "BUG-5405", Status: "To Do"}, {Key: "STAT-1081", Status: "To Do"}})

	got := fetchJiraIssues(context.Background(), f)
	if got.Error != "" {
		t.Fatalf("error = %q", got.Error)
	}
	if !sameKeys(got.Issues, "INTEG-445", "BUG-5195", "BUG-5405", "STAT-1081") {
		t.Fatalf("issues = %v, want the planning lane first", keysOf(got.Issues))
	}
	for i, want := range []string{lanePlanning, lanePlanning, laneTodo, laneTodo} {
		if got.Issues[i].Lane != want {
			t.Fatalf("row %s lane = %q, want %q", got.Issues[i].Key, got.Issues[i].Lane, want)
		}
	}
}

// TestFetchJiraIssuesDedupesAnIssueInBothLanes pins the one rule that survived
// the merge: an issue matching BOTH searches is shown once, in the lane
// furthest along the pipeline.
func TestFetchJiraIssuesDedupesAnIssueInBothLanes(t *testing.T) {
	t.Setenv("SLASH_JIRA", "")
	f := &jira.Fake{}
	f.SetSearch(planningJQL, []jira.Issue{{Key: "PROD-1", Status: "In Progress"}})
	f.SetSearch(todoJQL, []jira.Issue{{Key: "PROD-1", Status: "To Do"}, {Key: "PROD-9", Status: "To Do"}})

	got := fetchJiraIssues(context.Background(), f)
	if !sameKeys(got.Issues, "PROD-1", "PROD-9") {
		t.Fatalf("issues = %v, want PROD-1 once, in the planning lane", keysOf(got.Issues))
	}
	if got.Issues[0].Lane != lanePlanning {
		t.Fatalf("PROD-1 lane = %q, want %q", got.Issues[0].Lane, lanePlanning)
	}
}

// TestFetchJiraIssuesOffIsEmptyNotAnError — with Jira switched off (offline,
// tests) the section is simply absent; the endpoint still answers ok.
func TestFetchJiraIssuesOffIsEmptyNotAnError(t *testing.T) {
	t.Setenv("SLASH_JIRA", "off")
	got := fetchJiraIssues(context.Background(), &jira.Fake{})
	if !got.OK || got.Error == "" {
		t.Fatalf("got %+v, want ok with a reason", got)
	}
	if len(got.Issues) != 0 {
		t.Fatalf("issues = %+v, want empty", got.Issues)
	}
}

// TestGroupIssuesNestsSubtasksUnderTheirParent pins the three halves of the
// grouping rule, now across BOTH lanes: a Sub-task whose parent is in the list
// moves under it (the group taking the earliest member's position), a Sub-task
// whose parent is NOT in either list gets that parent pulled in as an
// unclickable context row above it, and a Sub-task that does not know its
// parent yet learns it through a per-issue read (the search cannot return one,
// see modules/jira/search.go). The todo-lane Sub-task is the regression this
// covers: grouping used to run over the planning list only, so a queued
// Sub-task sat there with no main task named anywhere ("elke subtaak moet een
// parent hebben … ik zie het niet bij alle subtaken").
func TestGroupIssuesNestsSubtasksUnderTheirParent(t *testing.T) {
	f := &jira.Fake{}
	f.SetIssue("STAT-1123", jira.Issue{Key: "STAT-1123", ParentKey: "STAT-900", ParentTitle: "Search parent"})
	f.SetIssue("STAT-900", jira.Issue{Key: "STAT-900", Title: "Fetched parent", Type: "Story"})

	got := groupIssues(context.Background(), f,
		[]jira.Issue{{Key: "INTEG-445", Type: "Story", Status: "In Progress"}},
		[]jira.Issue{
			{Key: "BUG-5405", Type: "Bug", Status: "To Do"},
			{Key: "STAT-1123", Type: "Sub-task", Status: "To Do"},
			{Key: "PROD-216", Type: "Story", Status: "To Do"},
			{Key: "PROD-254", Type: "Sub-task", Status: "To Do", ParentKey: "PROD-216"},
		})

	want := []string{"INTEG-445", "BUG-5405", "STAT-900", "STAT-1123", "PROD-216", "PROD-254"}
	if !sameKeys(got, want...) {
		t.Fatalf("keys = %v, want %v", keysOf(got), want)
	}
	if !got[2].Context || got[2].Title != "Fetched parent" || got[2].Lane != laneTodo {
		t.Fatalf("pulled-in parent = %+v, want a todo-lane context row read via Issue()", got[2])
	}
	for i, r := range got {
		if i != 2 && r.Context {
			t.Fatalf("row %s is marked context, but it is in the list itself", r.Key)
		}
	}
	// The Sub-task keeps its parent KEY, which is what lets the row name the
	// main task in words even when no context header was created.
	if got[3].ParentKey != "STAT-900" || got[5].ParentKey != "PROD-216" {
		t.Fatalf("subtasks lost their parent key: %+v / %+v", got[3], got[5])
	}
}

// TestGroupIssuesPullsInAParentOutsideTheSprint pins the rule Reindert
// confirmed when the sprint filter was questioned: "als er iets in deze sprint
// zit, dan dat laten zien en de hoofdtaak als het een subitem is". A shown
// Sub-task ALWAYS brings its main task, whatever that main task's own sprint,
// status or assignee is — which holds because the parent lookup does not go
// through the two sprint-scoped JQL queries at all: readIssues reads the
// parent BY KEY (cl.Issue -> `acli jira workitem view <key>`), a path with no
// sprint/assignee/status clause anywhere. This test locks that in: the parent
// here is in neither search result (out of sprint), is somebody else's and is
// Done, and it still arrives — as a context row, uncounted and unclickable.
func TestGroupIssuesPullsInAParentOutsideTheSprint(t *testing.T) {
	f := &jira.Fake{}
	f.SetIssue("PROD-216", jira.Issue{
		Key: "PROD-216", Title: "Out of sprint, someone else's", Type: "Story",
		Status: "Done", Assignee: "Dennis Sloove",
	})

	got := groupIssues(context.Background(), f, nil, []jira.Issue{
		{Key: "PROD-254", Type: "Sub-task", Status: "To Do", ParentKey: "PROD-216", Assignee: "Reindert Vetter"},
	})

	if !sameKeys(got, "PROD-216", "PROD-254") {
		t.Fatalf("keys = %v, want the main task above its Sub-task", keysOf(got))
	}
	if !got[0].Context || got[0].Title != "Out of sprint, someone else's" || got[0].Assignee != "Dennis Sloove" {
		t.Fatalf("parent = %+v, want a context row naming its own assignee", got[0])
	}
	// It was read BY KEY, never searched — a search would have applied
	// `sprint in openSprints()` and dropped it.
	if len(f.SearchCalls) != 0 {
		t.Fatalf("searches = %v, want the parent read by key instead", f.SearchCalls)
	}
	if len(f.Calls) == 0 || f.Calls[len(f.Calls)-1] != "PROD-216" {
		t.Fatalf("reads = %v, want a per-key read of PROD-216", f.Calls)
	}
}

// TestGroupIssuesLiftsAMixedStatusGroupAboveTodo — the sort rule the merge
// added: a GROUP carries the planning lane as soon as ANY of its own members is
// in it, so a main task that is still To Do rides ABOVE the plain todo rows
// when one of its subtasks is already In Progress ("als er een groep is, met
// verschillende statussen, gooi ze boven todo").
func TestGroupIssuesLiftsAMixedStatusGroupAboveTodo(t *testing.T) {
	got := groupIssues(context.Background(), &jira.Fake{},
		[]jira.Issue{{Key: "PROD-254", Type: "Sub-task", Status: "In Progress", ParentKey: "PROD-216"}},
		[]jira.Issue{
			{Key: "BUG-5405", Type: "Bug", Status: "To Do"},
			{Key: "PROD-216", Type: "Story", Status: "To Do"},
		})

	want := []string{"PROD-216", "PROD-254", "BUG-5405"}
	if !sameKeys(got, want...) {
		t.Fatalf("keys = %v, want the mixed group above the todo row (%v)", keysOf(got), want)
	}
	// The head row keeps its OWN lane/status — only the group's POSITION is
	// lifted, so the row still says "To Do" in words.
	if got[0].Lane != laneTodo || got[0].Status != "To Do" {
		t.Fatalf("head = %+v, want its own todo lane and status kept", got[0])
	}
}

// TestGroupIssuesKeepsAnUnreadableParentOut — the enrichment is best-effort: a
// parent that cannot be read (offline, no permission) yields no context row,
// and its Sub-task stays an ordinary top-level row that still knows the key of
// the main task it belongs to.
func TestGroupIssuesKeepsAnUnreadableParentOut(t *testing.T) {
	got := groupIssues(context.Background(), &jira.Fake{}, nil, []jira.Issue{
		{Key: "PROD-254", Type: "Sub-task", ParentKey: "STAT-900", ParentTitle: "Search parent"},
	})
	if len(got) != 1 || got[0].Key != "PROD-254" || got[0].Context {
		t.Fatalf("got %+v, want just the Sub-task itself", got)
	}
	if got[0].ParentKey != "STAT-900" {
		t.Fatalf("got %+v, want the parent key kept so the row can name it", got[0])
	}
}

// TestStartJiraProgressMovesTheTicket pins the ONE write this feature does:
// once the reviewer answered which branch the plan goes out from, the ticket
// moves to the very status the planning lane selects on, so the row leaves the
// todo lane ("als je in todo een branch hebt aangemaakt (eerste vraag), moet
// het naar in planning en in jira naar in progress"). It goes through the
// module's write method from a workflow Activity, never from a handler
// (.claude/rules/workflows-write-boundary.md).
func TestStartJiraProgressMovesTheTicket(t *testing.T) {
	t.Setenv("SLASH_JIRA", "")
	f := &jira.Fake{}
	m, _, _ := testJiraIssuesManager(t, f)

	m.startJiraProgress(context.Background(), "PAYM-813")

	if len(f.Transitions) != 1 || f.Transitions[0].Key != "PAYM-813" || f.Transitions[0].Status != "In Progress" {
		t.Fatalf("transitions = %+v, want PAYM-813 -> In Progress", f.Transitions)
	}
}

// TestStartJiraProgressSurvivesARefusedTransition — a ticket whose workflow
// cannot reach that status from where it is (including "it is already there")
// must not sink the plan the reviewer is waiting on: the failure is logged, and
// nothing else happens.
func TestStartJiraProgressSurvivesARefusedTransition(t *testing.T) {
	t.Setenv("SLASH_JIRA", "")
	f := &jira.Fake{TransitionErr: errors.New("acli: transition not available")}
	m, _, _ := testJiraIssuesManager(t, f)

	m.startJiraProgress(context.Background(), "PAYM-813")

	if len(f.Transitions) != 0 {
		t.Fatalf("transitions = %+v, want none recorded", f.Transitions)
	}
}

// failingSearch is a jira.Client whose searches always fail — the "acli is not
// logged in" / "Jira is down" case the tracker must survive.
type failingSearch struct{ jira.Fake }

func (f *failingSearch) Search(context.Context, string, int) ([]jira.Issue, error) {
	return nil, errors.New("acli: not logged in")
}

// testJiraIssuesManager wires a TaskManager on a memory engine with a
// throwaway jiraissues read-model, so a test can drive the real jira_issues
// tracker end to end (which also pins that the Workflow Type and the
// "refreshJiraIssues" Activity are registered under those exact names —
// both are plain strings nothing else would catch).
func testJiraIssuesManager(t *testing.T, cl jira.Client) (*TaskManager, *tembed.Engine, *jiraissues.Module) {
	t.Helper()
	dir := t.TempDir()
	cs, err := comments.Open(filepath.Join(dir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	ji, err := jiraissues.Open(filepath.Join(dir, "jiraissues.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ji.Close() })

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t),
		nil, nil, nil, nil, nil, cl, nil, dir, "test/repo")
	m.jiraissues = ji
	return m, engine, ji
}

// TestJiraIssuesTrackerStoresTheList — one refresh Signal writes the merged
// list into the read-model, which is all GET /api/jira/issues then reads.
func TestJiraIssuesTrackerStoresTheList(t *testing.T) {
	t.Setenv("SLASH_JIRA", "")
	f := &jira.Fake{}
	f.SetSearch(planningJQL, []jira.Issue{{Key: "PROD-2", Status: "In Progress"}})
	f.SetSearch(todoJQL, []jira.Issue{{Key: "PROD-9", Status: "To Do"}})
	m, _, ji := testJiraIssuesManager(t, f)

	runID := m.EnsureJiraIssues(context.Background())
	if runID == "" {
		t.Fatal("no jira_issues run started")
	}
	m.signalJiraIssues(runID, JiraIssuesSignal{Kind: "refresh"})

	snap, err := ji.Get(context.Background())
	if err != nil || snap == nil {
		t.Fatalf("get: %v / %+v", err, snap)
	}
	if !strings.Contains(string(snap.Issues), "PROD-2") || !strings.Contains(string(snap.Issues), "PROD-9") {
		t.Fatalf("snapshot = %s, want both lanes stored", snap.Issues)
	}
	if snap.Error != "" {
		t.Fatalf("error = %q, want none", snap.Error)
	}
}

// TestJiraIssuesTrackerSurvivesAFailedFetch — a failing search is a RESULT, not
// an Activity error: the tracker must stay waiting for the next tick (a failed
// one would never poll again until a restart), and the previous snapshot must
// stay on screen with only the reason refreshed.
func TestJiraIssuesTrackerSurvivesAFailedFetch(t *testing.T) {
	t.Setenv("SLASH_JIRA", "")
	f := &jira.Fake{}
	f.SetSearch(planningJQL, []jira.Issue{{Key: "PROD-2", Status: "In Progress"}})
	m, engine, ji := testJiraIssuesManager(t, f)
	runID := m.EnsureJiraIssues(context.Background())
	m.signalJiraIssues(runID, JiraIssuesSignal{Kind: "refresh"})

	// Now Jira goes away, and the poller ticks again.
	m.jira = &failingSearch{}
	m.signalJiraIssues(runID, JiraIssuesSignal{Kind: "refresh"})

	status, err := engine.Status(runID)
	if err != nil {
		t.Fatal(err)
	}
	if status == tembed.StatusFailed || status == tembed.StatusCompleted {
		t.Fatalf("status = %v, want the tracker still waiting for the next refresh", status)
	}
	snap, err := ji.Get(context.Background())
	if err != nil || snap == nil {
		t.Fatalf("get: %v / %+v", err, snap)
	}
	if !strings.Contains(string(snap.Issues), "PROD-2") {
		t.Fatalf("issues = %s, want the last good list kept", snap.Issues)
	}
	if snap.Error == "" {
		t.Fatal("error is empty, want the reason of the failed refresh")
	}
}
