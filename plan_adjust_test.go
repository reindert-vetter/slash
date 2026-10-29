package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/github"
	"slash/modules/jira"
	"slash/modules/plan"
)

func adjustTasks() []planTask {
	return []planTask{
		{ID: "t1", Title: "Eerste taak", Explanation: "een"},
		{ID: "t2", Title: "Tweede taak", Explanation: "twee"},
		{ID: "t3", Title: "Derde taak", Explanation: "drie"},
	}
}

func TestApplyPlanOpsKeepsStateNotesAndOrder(t *testing.T) {
	states := []planTaskState{
		{Key: planTaskKey("Tweede taak"), Title: "Tweede taak", Off: true},
		{Key: planTaskKey("Derde taak"), Title: "Derde taak", Note: "mijn notitie"},
	}
	ops := []planOp{
		{Op: "update", Title: "derde  taak", Task: &planRawTask{Title: "Derde taak (nieuw)", Explanation: "drie!"}},
		{Op: "update", Title: "Tweede taak", Task: &planRawTask{Explanation: "mag niet"}}, // unchecked: untouched
		{Op: "remove", Title: "Tweede taak"}, // unchecked: untouched
		{Op: "add", After: "Eerste taak", Task: &planRawTask{Title: "Nieuwe taak", Explanation: "nieuw"}},
		{Op: "add", Task: &planRawTask{Title: "eerste TAAK"}}, // duplicate: skipped
		{Op: "remove", Title: "bestaat niet"},                 // unknown: skipped
		{Op: "add", Task: &planRawTask{Title: "Achteraan"}},   // at the end
		{Op: "remove", Title: "Eerste taak"},
	}
	got, st, applied := applyPlanOps(adjustTasks(), states, ops)
	var titles []string
	for i, tk := range got {
		titles = append(titles, tk.Title)
		if tk.ID != "t"+string(rune('1'+i)) {
			t.Fatalf("ids must be renumbered, got %q at %d", tk.ID, i)
		}
	}
	want := "Nieuwe taak|Tweede taak|Derde taak (nieuw)|Achteraan"
	if strings.Join(titles, "|") != want || applied != 4 {
		t.Fatalf("titles %q applied %d, want %q applied 4", strings.Join(titles, "|"), applied, want)
	}
	if got[1].Explanation != "twee" || got[2].Explanation != "drie!" {
		t.Fatalf("explanations: %+v", got)
	}
	// The note followed the renamed task; the unchecked one stays unchecked.
	if s := planTaskStateFor(st, "Derde taak (nieuw)"); s.Note != "mijn notitie" {
		t.Fatalf("state did not follow the rename: %+v", st)
	}
	if planTaskEnabled(st, "Tweede taak") {
		t.Fatal("the unchecked task must stay unchecked")
	}
}

func TestApplyPlanOpsRespectsTheTaskCap(t *testing.T) {
	var tasks []planTask
	for i := 0; i < maxPlanTasks; i++ {
		tasks = append(tasks, planTask{Title: "t" + string(rune('a'+i))})
	}
	got, _, applied := applyPlanOps(tasks, nil, []planOp{{Op: "add", Task: &planRawTask{Title: "te veel"}}})
	if len(got) != maxPlanTasks || applied != 0 {
		t.Fatalf("len %d applied %d, want the cap held", len(got), applied)
	}
}

func TestParsePlanOps(t *testing.T) {
	ans, err := parsePlanOps("```json\n{\"ops\":[{\"op\":\"remove\",\"title\":\"x\"}],\"fullRevision\":true}\n```")
	if err != nil || len(ans.Ops) != 1 || !ans.FullRevision {
		t.Fatalf("ans %+v err %v", ans, err)
	}
	if _, err := parsePlanOps("geen json"); err == nil {
		t.Fatal("want an error")
	}
}

func TestPlanSalvageTruncatedKeepsCompleteTasks(t *testing.T) {
	full := `{"questions":[],"tasks":[{"title":"Een","explanation":"a } \" b","blocks":[{"title":"x","code":"f() {}","children":[]}]},{"title":"Twee"},{"title":"Drie","explanation":"afge`
	body := planSalvageTruncated(full)
	_, tasks, err := parsePlanAnswer(body)
	if err != nil || len(tasks) != 2 || tasks[0].Title != "Een" || tasks[1].Title != "Twee" {
		t.Fatalf("tasks %+v err %v body %s", tasks, err, body)
	}
	if planSalvageTruncated(`{"questions":[],"tasks":[{"title":"half`) != "" {
		t.Fatal("nothing complete: want empty")
	}
}

func TestPlanPendingChangeSignalsCountsOnlyPlanChangingOnes(t *testing.T) {
	sig := func(v PlanAnswerSignal) tembed.Event {
		b, _ := json.Marshal(v)
		return tembed.Event{Type: tembed.EventSignalReceived, Name: SignalPlanAnswer, Payload: b}
	}
	hist := []tembed.Event{
		{Type: tembed.EventWorkflowStarted},
		sig(PlanAnswerSignal{QuestionID: "q1", OptionID: "q1o1"}), // consumed
		sig(PlanAnswerSignal{QuestionID: "q2", OptionID: "q2o1"}),
		sig(PlanAnswerSignal{Kind: planAnswerChat, Text: "hoi"}),
		sig(PlanAnswerSignal{Kind: planAnswerTask, TaskTitle: "x"}),
		sig(PlanAnswerSignal{Kind: planAnswerComment}),
		sig(PlanAnswerSignal{Kind: planAnswerTopic, TopicID: "o1"}),
	}
	if n := planPendingChangeSignals(hist, 1); n != 3 {
		t.Fatalf("pending = %d, want answer + comment + topic", n)
	}
	if n := planPendingChangeSignals(hist, 6); n != 0 {
		t.Fatalf("pending = %d, want none once all are consumed", n)
	}
	doc := planDoc{TracksAnswers: true, AnswersSeen: 1}
	if !applyRecordedAnswers(hist, &doc) || len(doc.Answers) != 1 || doc.Answers[0].QuestionID != "q2" {
		t.Fatalf("recorded answers not shown: %+v", doc.Answers)
	}
	old := planDoc{AnswersSeen: 0}
	if applyRecordedAnswers(hist, &old) {
		t.Fatal("a document that does not track answers must not claim waiting signals")
	}
}

// adjustFixture parks a plan tracker on the main loop with a three-task plan,
// built from a recorded history (so no live Claude call is made up to there).
type adjustFixture struct {
	t      *testing.T
	fake   *claude.Fake
	engine *tembed.Engine
	store  tembed.Store
	m      *TaskManager
	pl     *plan.Module
	runID  string
	seq    int
}

func newAdjustFixture(t *testing.T) *adjustFixture {
	t.Helper()
	f := &adjustFixture{t: t, fake: claude.NewFake(), store: tembed.NewMemoryStore(), runID: "plan-ADJ-1"}
	f.engine = tembed.New(f.store)
	jr := &jira.Fake{}
	jr.SetIssue("ADJ-1", jira.Issue{Key: "ADJ-1", Title: "Plan", Description: "Omschrijving"})
	pl, err := plan.Open(filepath.Join(t.TempDir(), "plan.db"))
	if err != nil {
		t.Fatal(err)
	}
	f.pl = pl
	f.m = NewTaskManager(f.engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, f.fake, jr, nil, "", "test/repo")
	f.m.plan = pl
	now := time.Now()
	if err := f.store.CreateRun(tembed.RunRecord{ID: f.runID, Workflow: WorkflowPlan, Status: tembed.StatusWaiting, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	loadDoc := planDoc{
		Key: "ADJ-1", Title: "Plan", Description: "Omschrijving", SplitGenerate: true, SavesGateAnswer: true,
		Questions: []planQuestion{{ID: "q1", Question: "Kies", Options: []planOption{{ID: "q1o1", Label: "A"}, {ID: "q1o2", Label: "B"}}}},
		Tasks:     adjustTasks(), Answers: []planAnswer{},
	}
	f.add(tembed.Event{Type: tembed.EventWorkflowStarted, Payload: f.marshal(PlanInput{Key: "ADJ-1"})})
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planLoadIssue", Payload: f.marshal(loadDoc)})
	// planGenerateFresh: questions + save, tasks + save.
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planGenerate", Payload: f.marshal(loadDoc)})
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planSave"})
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planGenerate", Payload: f.marshal(loadDoc)})
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planSave"})
	return f
}

func (f *adjustFixture) marshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		f.t.Fatal(err)
	}
	return b
}

func (f *adjustFixture) add(ev tembed.Event) {
	ev.Seq, ev.Time = f.seq, time.Now()
	if err := f.store.AppendEvent(f.runID, ev); err != nil {
		f.t.Fatal(err)
	}
	f.seq++
}

func (f *adjustFixture) recover() {
	f.t.Helper()
	if err := f.engine.Recover(); err != nil {
		f.t.Fatalf("Recover: %v", err)
	}
	f.settle()
}

func (f *adjustFixture) settle() {
	done := make(chan struct{})
	go func() { f.engine.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		f.t.Fatal("engine.Wait did not return")
	}
}

func (f *adjustFixture) doc() planDoc {
	f.t.Helper()
	doc, ok := f.m.PlanDoc(context.Background(), "ADJ-1")
	if !ok {
		f.t.Fatal("no document")
	}
	return doc
}

const adjustAddTaskOps = `{"ops":[{"op":"add","task":{"title":"Nieuwe taak","explanation":"erbij"}}],"fullRevision":false}`

// Two answers already waiting in the history are merged: the first generation
// skips itself (no Claude call), the second one covers both — and the plan is
// ADJUSTED, so the three existing tasks stay.
func TestPlanAnswersWaitingInTheHistoryAreMergedIntoOneAdjust(t *testing.T) {
	f := newAdjustFixture(t)
	f.fake.SetOutput(claude.ModelOpus, adjustAddTaskOps)
	f.add(tembed.Event{Type: tembed.EventSignalReceived, Name: SignalPlanAnswer, Payload: f.marshal(PlanAnswerSignal{QuestionID: "q1", OptionID: "q1o1"})})
	f.add(tembed.Event{Type: tembed.EventSignalReceived, Name: SignalPlanAnswer, Payload: f.marshal(PlanAnswerSignal{QuestionID: "q2", OptionID: "q2o1"})})
	f.recover()

	if n := f.fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want ONE adjust for both answers", n)
	}
	prompt := f.fake.Calls[0].Prompt
	if !strings.Contains(prompt, "HET HUIDIGE PLAN") || !strings.Contains(prompt, "NIEUW OF GEWIJZIGD") || !strings.Contains(prompt, "q2o1") {
		t.Fatalf("not an adjust prompt carrying both answers:\n%s", prompt)
	}
	doc := f.doc()
	if len(doc.Answers) != 2 || len(doc.PlannedAnswers) != 2 || doc.GenStale || doc.GenOutcome != "" {
		t.Fatalf("doc: answers %v planned %v stale %v outcome %q", doc.Answers, doc.PlannedAnswers, doc.GenStale, doc.GenOutcome)
	}
	var titles []string
	for _, tk := range doc.Tasks {
		titles = append(titles, tk.Title)
	}
	if strings.Join(titles, "|") != "Eerste taak|Tweede taak|Derde taak|Nieuwe taak" {
		t.Fatalf("tasks = %q, want the plan adjusted, not rebuilt", titles)
	}
}

// An answer that arrives while an adjust runs cancels it; the next generation
// covers both answers.
func TestPlanAnswerDuringAGenerationAbortsItAndMerges(t *testing.T) {
	f := newAdjustFixture(t)
	f.fake.SetOutput(claude.ModelOpus, adjustAddTaskOps)
	f.fake.SetChatBlockUntilCancel(true)
	f.recover()

	first := true
	f.fake.SetChatHook(func(claude.RunRequest) {
		if !first {
			return
		}
		first = false
		// The second answer lands while the first generation "runs".
		if err := f.engine.SignalWorkflow(f.runID, SignalPlanAnswer, PlanAnswerSignal{QuestionID: "q2", OptionID: "q2o1"}); err != nil {
			t.Error(err)
		}
		notePlanChangeSignal("ADJ-1", "")
		f.fake.SetChatBlockUntilCancel(false) // later calls answer normally
	})
	if err := f.engine.SignalWorkflow(f.runID, SignalPlanAnswer, PlanAnswerSignal{QuestionID: "q1", OptionID: "q1o1"}); err != nil {
		t.Fatal(err)
	}
	f.settle()

	if n := f.fake.CallCount(); n != 2 {
		t.Fatalf("claude called %d times, want the aborted call plus ONE merged adjust", n)
	}
	doc := f.doc()
	if len(doc.Answers) != 2 || len(doc.PlannedAnswers) != 2 || doc.GenStale || doc.Error != "" {
		t.Fatalf("doc: answers %v planned %v stale %v error %q", doc.Answers, doc.PlannedAnswers, doc.GenStale, doc.Error)
	}
	if len(doc.Tasks) != 4 || doc.Tasks[3].Title != "Nieuwe taak" {
		t.Fatalf("tasks = %+v", doc.Tasks)
	}
	if !strings.Contains(f.fake.Calls[1].Prompt, "q2o1") || !strings.Contains(f.fake.Calls[1].Prompt, "Kies → A") {
		t.Fatalf("the second call must carry both answers:\n%s", f.fake.Calls[1].Prompt)
	}
}

// fullRevision from the model automatically runs the ordinary full rebuild.
func TestPlanAdjustFullRevisionFallsBackToAFullGeneration(t *testing.T) {
	f := newAdjustFixture(t)
	f.recover()
	// The first call (adjust) answers fullRevision; the second (the full
	// "tasks" call) gets a whole new list.
	f.fake.SetOutput(claude.ModelOpus, `{"ops":[],"fullRevision":true}`)
	calls := 0
	f.fake.SetChatHook(func(claude.RunRequest) {
		calls++
		if calls == 2 {
			f.fake.SetOutput(claude.ModelOpus, `{"questions":[],"tasks":[{"title":"Volledig nieuw","explanation":"x"}]}`)
		}
	})
	if err := f.engine.SignalWorkflow(f.runID, SignalPlanAnswer, PlanAnswerSignal{QuestionID: "q1", OptionID: "q1o1"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	if n := f.fake.CallCount(); n != 2 {
		t.Fatalf("claude called %d times, want adjust + full rebuild", n)
	}
	if !strings.Contains(f.fake.Calls[1].Prompt, `"tasks": maximaal`) {
		t.Fatalf("second call must be the full tasks generation:\n%s", f.fake.Calls[1].Prompt)
	}
	doc := f.doc()
	if len(doc.Tasks) != 1 || doc.Tasks[0].Title != "Volledig nieuw" {
		t.Fatalf("tasks = %+v", doc.Tasks)
	}
}

// A history recorded before adjust existed (answer -> save -> generate ->
// save, no outcome fields) replays without a single live call.
func TestPlanWorkflowReplaysAnOldAnswerHistoryWithoutLiveCalls(t *testing.T) {
	f := newAdjustFixture(t)
	f.add(tembed.Event{Type: tembed.EventSignalReceived, Name: SignalPlanAnswer, Payload: f.marshal(PlanAnswerSignal{QuestionID: "q1", OptionID: "q1o1"})})
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planSave"})
	oldGen := `{"key":"ADJ-1","title":"Plan","description":"Omschrijving","questions":[],"tasks":[{"id":"t1","title":"Oud"}],"answers":[{"questionId":"q1","optionId":"q1o1"}],"error":""}`
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planGenerate", Payload: json.RawMessage(oldGen)})
	f.add(tembed.Event{Type: tembed.EventActivityCompleted, Name: "planSave"})
	f.recover()
	if n := f.fake.CallCount(); n != 0 {
		t.Fatalf("replay made %d live claude calls", n)
	}
	status, err := f.engine.Status(f.runID)
	if err != nil || status != tembed.StatusWaiting {
		t.Fatalf("status %q err %v, want waiting", status, err)
	}
}

// GET /api/plan reports generating while a planGenerate really runs, although
// the tracker's tembed status reads `waiting` for a signal's inline generation.
func TestHandlePlanReportsGeneratingWhileTheGenerationRuns(t *testing.T) {
	f := newAdjustFixture(t)
	f.recover()
	// A live save, so the read model has a stored document (the recorded
	// history's saves were replayed, not executed).
	if err := f.engine.SignalWorkflow(f.runID, SignalPlanAnswer, PlanAnswerSignal{Kind: planAnswerTask, TaskTitle: "Eerste taak", TaskNote: "n"}); err != nil {
		t.Fatal(err)
	}
	s := &server{tasks: &tasks{manager: f.m}}
	get := func() bool {
		rec := httptest.NewRecorder()
		s.handlePlan(rec, httptest.NewRequest("GET", "/api/plan?key=ADJ-1", nil))
		var body struct {
			Generating bool `json:"generating"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Generating
	}
	if get() {
		t.Fatal("an idle tracker must not read as generating")
	}
	conv := planGenerateConversationID("ADJ-1")
	startChatProgress("", 0, conv)
	if !get() {
		t.Fatal("a running planGenerate snapshot must read as generating")
	}
	finishChatProgress("", 0, conv)
	if get() {
		t.Fatal("generating must clear once the Activity is done")
	}
}
