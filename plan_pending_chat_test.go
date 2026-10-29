package main

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/github"
	"slash/modules/jira"
	"slash/modules/plan"
)

// pendingPlanChat shows exactly the chat signals past the tracker's own
// per-name count — reported on STAT-1155: a message sent during the first
// generation vanished on a refresh until that generation was done.
func TestPendingPlanChatShowsOnlyUnhandledMessages(t *testing.T) {
	sig := func(name string, v any) tembed.Event {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return tembed.Event{Type: tembed.EventSignalReceived, Name: name, Payload: b}
	}
	hist := []tembed.Event{
		{Type: tembed.EventWorkflowStarted},
		// Older, without a client id: ignored on both sides.
		sig(SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerChat, Text: "oud"}),
		sig(SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerChat, Text: "al verwerkt", ClientID: "a1"}),
		sig(SignalPlanHotfix, PlanHotfixSignal{Hotfix: true}),
		sig(SignalPlanAnswer, PlanAnswerSignal{Kind: planAnswerChat, Text: "  wacht nog  ", ClientID: "b2"}),
		sig(SignalPlanAnswer, PlanAnswerSignal{Kind: planAnswerTopic, TopicID: "o1", Text: "x", ClientID: "c3"}),
		sig(SignalPlanAnswer, PlanAnswerSignal{Kind: planAnswerChat, Text: "ongeldig id", ClientID: "<script>"}),
		sig(SignalPlanAnswer, PlanAnswerSignal{Kind: planAnswerChat, Attachments: []ChatAttachmentRef{{ID: "img1"}}, ClientID: "d4"}),
	}
	doc := planDoc{ChatSeen: map[string]int{SignalPlanHotfix: 1}}
	got := pendingPlanChat(hist, doc)
	if len(got) != 2 || got[0].ClientID != "b2" || got[0].Body != "wacht nog" || got[1].ClientID != "d4" || got[1].Body != chatAttachmentOnlyBody(1) {
		t.Fatalf("pending = %+v, want b2 and the image-only d4", got)
	}
	// Once the tracker counts it, it is no longer pending — also after a
	// regenerate emptied doc.Chat (the count is never reset).
	doc.ChatSeen[SignalPlanAnswer] = 2
	if got := pendingPlanChat(hist, doc); len(got) != 0 {
		t.Fatalf("pending = %+v, want none", got)
	}
}

// The tracker counts a handled chat message with a client id, so the read
// model drops it from the pending list the moment it is saved.
func TestPlanChatCountsHandledClientIDs(t *testing.T) {
	withBlockingBaseGate(t)
	jr := &jira.Fake{}
	jr.SetIssue("TEST-1", jira.Issue{Key: "TEST-1", Title: "Iets kapots", Type: "Bug"})
	engine := tembed.New(tembed.NewMemoryStore())
	cl := claude.NewFake()
	cl.SetChatTurns("Prima.")
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, cl, jr, nil, "", "test/repo")
	pl, err := plan.Open(filepath.Join(t.TempDir(), "plan.db"))
	if err != nil {
		t.Fatal(err)
	}
	m.plan = pl
	runID, err := m.StartPlan("TEST-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerChat, Text: "hoi", ClientID: "abc-1"}); err != nil {
		t.Fatal(err)
	}
	doc, ok := m.PlanDoc(t.Context(), "TEST-1")
	if !ok {
		t.Fatal("no document")
	}
	if doc.ChatSeen[SignalPlanHotfix] != 1 || len(doc.Chat) == 0 || doc.Chat[0].ClientID != "abc-1" {
		t.Fatalf("doc = chatSeen %v chat %+v, want the message counted and carrying its id", doc.ChatSeen, doc.Chat)
	}
	if got := pendingPlanChat(m.planHistory("TEST-1"), doc); len(got) != 0 {
		t.Fatalf("pending = %+v, want none once handled", got)
	}
	for _, c := range []struct {
		signal, payload string
		want            bool
	}{
		{SignalPlanAnswer, `{"kind":"chat"}`, true},
		{SignalPlanHotfix, `{"kind":"topic"}`, true},
		{SignalPlanHotfix, `{"hotfix":true}`, true},
		{SignalPlanScope, `{"choice":"parent"}`, true},
		{SignalPlanHotfix, `{"kind":"topics"}`, false},
		{SignalPlanAnswer, `{"kind":"followup"}`, false},
		// An answer and a Jira comment are recorded at once so a running
		// generation can give way to them (plan_adjust.go); a ticked task is not.
		{SignalPlanAnswer, `{"questionId":"q1","optionId":"q1o1"}`, true},
		{SignalPlanAnswer, `{"kind":"comment"}`, true},
		{SignalPlanAnswer, `{"kind":"task","taskTitle":"x"}`, false},
		{SignalPlanHotfix, `{"questionId":"q1","optionId":"q1o1"}`, true},
	} {
		if got := planSignalRecordsWhileBusy(c.signal, []byte(c.payload)); got != c.want {
			t.Fatalf("planSignalRecordsWhileBusy(%s, %s) = %v, want %v", c.signal, c.payload, got, c.want)
		}
	}
}

// A branch answer recorded while the tracker was busy (the automatic topics
// run, on STAT-1155) is shown from the history before the tracker saves it;
// side signals on the same gate never count as the answer.
func TestApplyRecordedGateAnswer(t *testing.T) {
	sig := func(name string, v any) tembed.Event {
		b, _ := json.Marshal(v)
		return tembed.Event{Type: tembed.EventSignalReceived, Name: name, Payload: b}
	}
	doc := planDoc{NeedsHotfix: true, DefaultBranch: "develop", HotfixBranch: "master"}
	hist := []tembed.Event{sig(SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerTopics}), sig(SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerChat, Text: "x"})}
	if applyRecordedGateAnswer(hist, &doc) || !doc.NeedsHotfix {
		t.Fatal("side signals must not answer the gate")
	}
	hist = append(hist, sig(SignalPlanHotfix, PlanHotfixSignal{Hotfix: true}))
	if !applyRecordedGateAnswer(hist, &doc) || doc.NeedsHotfix || !doc.Hotfix || doc.BaseBranch != "master" {
		t.Fatalf("recorded answer not applied: %+v", doc)
	}
	scope := planDoc{NeedsScope: true}
	if !applyRecordedGateAnswer([]tembed.Event{sig(SignalPlanScope, PlanScopeSignal{Choice: "parent"})}, &scope) || scope.NeedsScope {
		t.Fatal("recorded scope answer not applied")
	}
}
