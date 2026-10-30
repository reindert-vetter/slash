package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/github"
	"slash/modules/jira"
	"slash/modules/plan"
)

// withBlockingBaseGate switches a test back to the original, blocking
// base-branch question (what an Execution recorded before DefaultsBase did).
func withBlockingBaseGate(t *testing.T) {
	t.Helper()
	prev := planBaseGateDefaults
	planBaseGateDefaults = false
	t.Cleanup(func() { planBaseGateDefaults = prev })
}

func TestPlanQueueApplyRules(t *testing.T) {
	var q []planQueueItem
	q = planQueueApply(q, planQueueReview, false)
	if planQueueFind(q, planQueueExecute) < 0 || planQueueFind(q, planQueueReview) < 0 {
		t.Fatalf("review must pull execute in: %+v", q)
	}
	q = planQueueApply(q, planQueueExecute, true)
	if len(q) != 0 {
		t.Fatalf("cancelling execute must cancel the review that needs it: %+v", q)
	}
	q = planQueueApply(q, planQueueJira, false)
	q[0].Status = planQStatusDone
	q = planQueueApply(q, planQueueJira, true)
	if len(q) != 1 || q[0].Status != planQStatusDone {
		t.Fatalf("a started/done item cannot be cancelled: %+v", q)
	}
	q = planQueueApply(q, "bogus", false)
	if len(q) != 1 {
		t.Fatalf("an unknown action must be ignored: %+v", q)
	}
	q[0].Status = planQStatusFailed
	q = planQueueApply(q, planQueueJira, false)
	if q[0].Status != planQStatusQueued {
		t.Fatalf("a failed item can be queued again: %+v", q)
	}
}

func TestPlanReadyToExecute(t *testing.T) {
	ok := planDoc{Tasks: []planTask{{Title: "a"}}}
	if !planReadyToExecute(ok) {
		t.Fatal("a plan with tasks and no gate must be ready")
	}
	for name, d := range map[string]planDoc{
		"scope gate": {Tasks: ok.Tasks, NeedsScope: true},
		"no tasks":   {},
		"error":      {Tasks: ok.Tasks, Error: "x"},
		"stale":      {Tasks: ok.Tasks, GenStale: true},
	} {
		if planReadyToExecute(d) {
			t.Fatalf("%s: must not be ready", name)
		}
	}
}

func newQueueTestManager(t *testing.T, issue jira.Issue) (*TaskManager, *tembed.Engine, *jira.Fake, *claude.Fake) {
	t.Helper()
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `{"questions":[{"question":"Waar hoort dit?","options":[{"label":"In de service"}]}],`+
		`"tasks":[{"title":"Endpoint toevoegen","explanation":"Waarom"}]}`)
	jr := &jira.Fake{}
	jr.SetIssue("PAYM-813", issue)
	pl, err := plan.Open(filepath.Join(t.TempDir(), "plan.db"))
	if err != nil {
		t.Fatal(err)
	}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, fake, jr, nil, "", "test/repo")
	m.plan = pl
	return m, engine, jr, fake
}

// The base-branch question no longer blocks: the plan is generated straight
// away on develop, and the ticket is NOT moved to In Progress by itself.
func TestPlanBaseBranchDefaultsToDevelopWithoutBlocking(t *testing.T) {
	m, _, jr, _ := newQueueTestManager(t, jira.Issue{Title: "Iets kapots", Type: "Bug"})
	if _, err := m.StartPlan("PAYM-813"); err != nil {
		t.Fatal(err)
	}
	doc, ok := m.PlanDoc(context.Background(), "PAYM-813")
	if !ok || doc.NeedsHotfix || doc.BaseBranch != planDefaultBaseBranch() || len(doc.Tasks) == 0 {
		t.Fatalf("want a generated plan on the default branch, got %+v", doc)
	}
	if len(jr.Transitions) != 0 {
		t.Fatalf("the ticket must not move to In Progress on its own: %+v", jr.Transitions)
	}
}

// A queued Jira action starts at once (also behind the scope gate), a queued
// execute waits for the scope answer and starts as soon as the plan exists,
// and cancelling a queued item removes it.
func TestPlanQueueStartsWhenDue(t *testing.T) {
	started := 0
	planExecuteStarter = func(string) (string, error) { started++; return "run", nil }
	t.Cleanup(func() { planExecuteStarter = nil })
	m, engine, jr, _ := newQueueTestManager(t, jira.Issue{Title: "Hoofdtaak", Subtasks: []jira.IssueRef{{Key: "PAYM-814", Title: "Deel"}}})
	runID, err := m.StartPlan("PAYM-813")
	if err != nil {
		t.Fatal(err)
	}
	queue := func(action string, off bool) {
		t.Helper()
		if err := engine.SignalWorkflow(runID, SignalPlanScope, PlanScopeSignal{Kind: planAnswerQueue, Text: action, TopicOff: off}); err != nil {
			t.Fatal(err)
		}
	}
	queue(planQueueJira, false)
	queue(planQueueExecute, false)
	doc, _ := m.PlanDoc(context.Background(), "PAYM-813")
	if !doc.NeedsScope {
		t.Fatalf("the scope gate must still stand: %+v", doc)
	}
	if len(jr.Transitions) != 1 || jr.Transitions[0].Status != jiraInProgressStatus {
		t.Fatalf("jira must start at once: %+v", jr.Transitions)
	}
	if i := planQueueFind(doc.Queue, planQueueExecute); i < 0 || doc.Queue[i].Status != planQStatusQueued {
		t.Fatalf("execute must wait behind the scope gate: %+v", doc.Queue)
	}
	// Cancel and re-queue, then answer the scope question.
	queue(planQueueExecute, true)
	queue(planQueueExecute, false)
	if err := engine.SignalWorkflow(runID, SignalPlanScope, PlanScopeSignal{Choice: "parent"}); err != nil {
		t.Fatal(err)
	}
	doc, _ = m.PlanDoc(context.Background(), "PAYM-813")
	i := planQueueFind(doc.Queue, planQueueExecute)
	if i < 0 || doc.Queue[i].Status == planQStatusQueued {
		t.Fatalf("execute must have started once the plan was ready: %+v", doc.Queue)
	}
	if started != 1 {
		t.Fatalf("plan_execute must be started exactly once, got %d", started)
	}
	if len(jr.Transitions) != 1 {
		t.Fatalf("jira must only move once: %+v", jr.Transitions)
	}
}

// A finished plan_execute run without a draft PR fails the execute item and
// skips the review chain that needed it (instead of running it on nothing).
func TestPlanQueueExecDoneWithoutPRSkipsReview(t *testing.T) {
	planExecuteStarter = func(string) (string, error) { return "run", nil }
	t.Cleanup(func() { planExecuteStarter = nil })
	m, engine, _, _ := newQueueTestManager(t, jira.Issue{Title: "Hoofdtaak", Subtasks: []jira.IssueRef{{Key: "PAYM-814", Title: "Deel"}}})
	runID, err := m.StartPlan("PAYM-813")
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalPlanScope, PlanScopeSignal{Kind: planAnswerQueue, Text: planQueueReview}); err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalPlanScope, PlanScopeSignal{Choice: "parent"}); err != nil {
		t.Fatal(err)
	}
	doc, _ := m.PlanDoc(context.Background(), "PAYM-813")
	if i := planQueueFind(doc.Queue, planQueueExecute); i < 0 || doc.Queue[i].Status != planQStatusStarted {
		t.Fatalf("execute must be started: %+v", doc.Queue)
	}
	if err := engine.SignalWorkflow(runID, SignalPlanAnswer, PlanAnswerSignal{Kind: planAnswerExecDone}); err != nil {
		t.Fatal(err)
	}
	doc, _ = m.PlanDoc(context.Background(), "PAYM-813")
	e, r := planQueueFind(doc.Queue, planQueueExecute), planQueueFind(doc.Queue, planQueueReview)
	if doc.Queue[e].Status != planQStatusFailed || doc.Queue[r].Status != planQStatusSkipped {
		t.Fatalf("want execute failed and review skipped, got %+v", doc.Queue)
	}
}

// A finished draft PR gets its review tree at once, also without a queued
// review; with a queued review the chain's own ingest step reuses that tree
// instead of ingesting a second time.
func TestPlanQueueExecDoneBuildsTreeOnce(t *testing.T) {
	for _, withReview := range []bool{false, true} {
		planExecuteStarter = func(string) (string, error) { return "run", nil }
		planExecViewReader = func(string) PlanExecView {
			return PlanExecView{Status: "completed", PRNumber: 4242, Branch: "paym-813-x", Base: "develop"}
		}
		m, engine, _, _ := newQueueTestManager(t, jira.Issue{Title: "Hoofdtaak", Subtasks: []jira.IssueRef{{Key: "PAYM-814", Title: "Deel"}}})
		db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
		if err != nil {
			t.Fatal(err)
		}
		m.db = db
		ingests := 0
		planTreeIngester = func(arg planQueueChainArg) planQueueStep {
			ingests++
			if _, err := db.Exec(`INSERT INTO blocks (id, name, file, line, pr) VALUES ('b', 'f', 'a.php', 1, ?)`, arg.PR); err != nil {
				t.Fatal(err)
			}
			return planQueueStep{OK: true}
		}
		t.Cleanup(func() { planExecuteStarter, planExecViewReader, planTreeIngester = nil, nil, nil })

		runID, err := m.StartPlan("PAYM-813")
		if err != nil {
			t.Fatal(err)
		}
		action := planQueueExecute
		if withReview {
			action = planQueueReview
		}
		if err := engine.SignalWorkflow(runID, SignalPlanScope, PlanScopeSignal{Kind: planAnswerQueue, Text: action}); err != nil {
			t.Fatal(err)
		}
		if err := engine.SignalWorkflow(runID, SignalPlanScope, PlanScopeSignal{Choice: "parent"}); err != nil {
			t.Fatal(err)
		}
		if err := engine.SignalWorkflow(runID, SignalPlanAnswer, PlanAnswerSignal{Kind: planAnswerExecDone}); err != nil {
			t.Fatal(err)
		}
		doc, _ := m.PlanDoc(context.Background(), "PAYM-813")
		tr := planQueueFind(doc.Queue, planQueueTree)
		if tr < 0 || doc.Queue[tr].Status != planQStatusDone || doc.Queue[tr].PR != 4242 {
			t.Fatalf("review=%v: want a done tree row for #4242, got %+v", withReview, doc.Queue)
		}
		if ingests != 1 {
			t.Fatalf("review=%v: the tree must be ingested exactly once, got %d (%+v)", withReview, ingests, doc.Queue)
		}
		if withReview {
			if i := planQueueFind(doc.Queue, planQueueIngest); i < 0 || doc.Queue[i].Note != "de review-tree stond al klaar" {
				t.Fatalf("the chain's ingest step must reuse the tree: %+v", doc.Queue)
			}
		}
	}
}
