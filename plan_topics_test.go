package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/github"
	"slash/modules/jira"
	"slash/modules/plan"
)

func TestParsePlanTopicsNumbersAndDropsEmpties(t *testing.T) {
	got, err := parsePlanTopics("```json\n{\"topics\":[{\"title\":\"Probleem\",\"body\":\"MRR wijkt af.\"},{\"title\":\"\",\"body\":\"x\"},{\"title\":\"Tabel\",\"body\":\"| a | b |\\n|---|---|\\n| 1 | 2 |\"}]}\n```")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "o1" || got[1].ID != "o2" || !strings.Contains(got[1].Body, "| 1 | 2 |") {
		t.Fatalf("unexpected topics: %+v", got)
	}
	if _, err := parsePlanTopics(`{"topics":[]}`); err == nil {
		t.Fatal("an empty topic list must be an error")
	}
}

func TestUpsertPlanTopic(t *testing.T) {
	in := []planTopic{{ID: "o1", Title: "A", Body: "oud"}, {ID: "o2", Title: "B", Body: "b"}}
	out, changed := upsertPlanTopic(in, "o1", "nieuw", true)
	if !changed || !out[0].Off || out[0].Body != "nieuw" || !out[0].Edited || in[0].Body != "oud" {
		t.Fatalf("edit not folded (or input mutated): in=%+v out=%+v", in, out)
	}
	if _, changed := upsertPlanTopic(out, "o1", "nieuw", true); changed {
		t.Fatal("the same state again must not count as a change")
	}
	if _, changed := upsertPlanTopic(in, "o9", "x", false); changed {
		t.Fatal("an unknown id must change nothing")
	}
}

func TestPlanPromptsCarryTopicsAndChat(t *testing.T) {
	doc := planDoc{
		Key: "BUG-1", Title: "MRR verschil",
		Topics: []planTopic{{ID: "o1", Title: "Klantvraag", Body: "Tenant 4804 ziet 10k verschil."}, {ID: "o2", Title: "Export", Body: "x", Off: true}},
		Chat:   []planChatMessage{{Role: "user", Body: "Neem alleen jaarabonnementen mee."}},
	}
	for name, got := range map[string]string{
		"generate": planPrompt(doc, "tasks"),
		"execute":  planExecutePrompt(doc),
		"chat":     planChatPrompt(doc, planChatTools{}),
	} {
		for _, want := range []string{"Tenant 4804 ziet 10k verschil.", "BUITEN SCOPE", "- Export", "Neem alleen jaarabonnementen mee."} {
			if !strings.Contains(got, want) {
				t.Fatalf("%s prompt is missing %q:\n%s", name, want, got)
			}
		}
	}
	if strings.Contains(planTopicsPrompt(doc), "Tenant 4804 ziet 10k verschil.") {
		t.Fatal("the topics prompt must not feed the existing topics back in")
	}
}

func TestPlanChatPromptNamesTheDataSources(t *testing.T) {
	doc := planDoc{Key: "BUG-1", Chat: []planChatMessage{{Role: "user", Body: "hoi"}}}
	plain := planChatPrompt(doc, planChatTools{})
	if !strings.Contains(plain, "ClickHouse") || strings.Contains(plain, "duckdb") || strings.Contains(plain, "Read/Grep/Glob") {
		t.Fatalf("without tools the prompt names only the reviewer-run databases:\n%s", plain)
	}
	full := planChatPrompt(doc, planChatTools{Code: true, RequestLog: "/x/identifier.db"})
	if !strings.Contains(full, "duckdb -readonly /x/identifier.db") || !strings.Contains(full, "Read/Grep/Glob") {
		t.Fatalf("the prompt must offer the request log and the code:\n%s", full)
	}
}

func TestNormalizeRequestLogPath(t *testing.T) {
	for in, want := range map[string]string{
		"":                       "",
		" /a/b/identifier.db ":   "/a/b/identifier.db",
		"/a/b/identifier.db.wal": "/a/b/identifier.db",
	} {
		got, ok := normalizeRequestLogPath(in)
		if !ok || got != want {
			t.Fatalf("normalize(%q) = %q,%v want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"identifier.db", "/a b/x.db", "/a/x.db;rm -rf", "/a/x.db)", "/a/../x.db", "/a/x.txt"} {
		if _, ok := normalizeRequestLogPath(bad); ok {
			t.Fatalf("normalize(%q) must be rejected", bad)
		}
	}
}

func TestRequestLogFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	defer loadRequestLogFile(t.TempDir()) // back to the default for other tests
	loadRequestLogFile(dir)
	if configuredRequestLog() != defaultRequestLogPath {
		t.Fatalf("missing file must mean the default, got %q", configuredRequestLog())
	}
	if err := saveRequestLogFile(dir, "/tmp/x/identifier.db.wal"); err != nil {
		t.Fatal(err)
	}
	loadRequestLogFile(dir)
	if configuredRequestLog() != "/tmp/x/identifier.db" {
		t.Fatalf("got %q", configuredRequestLog())
	}
	if err := saveRequestLogFile(dir, ""); err != nil {
		t.Fatal(err)
	}
	loadRequestLogFile(dir)
	if configuredRequestLog() != "" || usableRequestLog() != "" {
		t.Fatal("an explicit empty path switches the request log off")
	}
}

// A topic edit made while the branch question still stands is saved right
// away (it rides the plan_hotfix wait) and does NOT answer that question —
// the reported "als ik input aanpas, dan is dat niet aangepast (na een
// refresh)" for the old intent field, which only rode plan_answer.
func TestPlanTopicsRideTheHotfixGate(t *testing.T) {
	jr := &jira.Fake{}
	jr.SetIssue("TEST-1", jira.Issue{Key: "TEST-1", Title: "Iets kapots", Description: "Tenant 4804 ziet een verschil.", Type: "Bug"})
	engine := tembed.New(tembed.NewMemoryStore())
	cl := claude.NewFake()
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
	cl.SetChatTurns(`{"topics":[{"title":"Probleem","body":"Tenant 4804 ziet een verschil."},{"title":"Export","body":"De export wijkt ook af."}]}`)
	if err := engine.SignalWorkflow(runID, SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerTopics}); err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerTopic, TopicID: "o2", TopicOff: true, Text: "Export laten we buiten beschouwing."}); err != nil {
		t.Fatal(err)
	}
	raw, ok, err := pl.Get(context.Background(), "TEST-1")
	if err != nil || !ok {
		t.Fatalf("doc not stored: %v %v", ok, err)
	}
	var doc planDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatal(err)
	}
	if !doc.NeedsHotfix {
		t.Fatal("a topic signal must not answer the branch question")
	}
	if len(doc.Topics) != 2 || !doc.Topics[1].Off || doc.Topics[1].Body != "Export laten we buiten beschouwing." || doc.TopicsAt == "" {
		t.Fatalf("topic edit not saved during the gate: %+v", doc.Topics)
	}
	// A second automatic request (another tab, a refresh) leaves them alone.
	if err := engine.SignalWorkflow(runID, SignalPlanHotfix, PlanHotfixSignal{Kind: planAnswerTopics}); err != nil {
		t.Fatal(err)
	}
	raw, _, _ = pl.Get(context.Background(), "TEST-1")
	_ = json.Unmarshal([]byte(raw), &doc)
	if !doc.Topics[1].Off {
		t.Fatalf("an automatic re-request must not overwrite edited topics: %+v", doc.Topics)
	}
}
