package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/github"
	"slash/modules/touchai"
)

func TestTouchChipKeys(t *testing.T) {
	sum := &touchSummary{
		DB:  []touchItem{{Kind: "alter", Name: "policies", Add: []string{"document_url"}, Del: []string{"old"}}},
		API: []touchItem{{Kind: "controller", Name: "PolicyController"}},
	}
	var keys []string
	for _, c := range touchChips(sum) {
		keys = append(keys, c.Key)
	}
	want := []string{"db|policies|+document_url", "db|policies|−old", "api|PolicyController|"}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}
}

func TestParseTouchAI(t *testing.T) {
	chips := []touchChip{{Key: "db|p|+a"}, {Key: "api|C|"}}
	raw := "sure:\n```json\n{\"impact\":\"Caution\",\"reason\":\"r\",\"summary\":\"s\",\"chips\":[{\"n\":1,\"verdict\":\"breaking\",\"note\":\"x\"},{\"n\":2,\"verdict\":\"meh\"},{\"n\":9,\"verdict\":\"safe\"}]}\n```"
	got := parseTouchAI(raw, chips)
	if got.Status != "done" || got.Impact != "caution" || got.Summary != "s" {
		t.Fatalf("got %+v", got)
	}
	if len(got.Chips) != 1 || got.Chips["db|p|+a"].Verdict != "breaking" {
		t.Fatalf("chips = %+v", got.Chips)
	}
	if parseTouchAI(`{"impact":"huge"}`, chips).Status != "failed" || parseTouchAI("", chips).Status != "failed" {
		t.Fatal("unknown impact / empty answer must be failed")
	}
}

func TestTouchAIStartsSkipsIgnoredAndSnoozed(t *testing.T) {
	sections := []inboxSection{{Title: touchedSectionTitle, PRs: []inboxRow{{Number: 1}, {Number: 2}, {Number: 3}}}, {Title: "Other", PRs: []inboxRow{{Number: 4}}}}
	statuses := map[string]prStatus{
		"1": {TouchSHA: "abc", MigrationFiles: []string{"db/migrations/x.php"}},
		"2": {TouchSHA: "def", APIFiles: []string{"routes/api.php"}},
		"3": {TouchSHA: "ghi", APIFiles: []string{"routes/api.php"}},
		"4": {TouchSHA: "jkl", APIFiles: []string{"routes/api.php"}},
	}
	got := touchAIStarts(sections, statuses, func(r inboxRow, _ prStatus) bool { return r.Number == 2 })
	if len(got) != 2 || got[0].PR != 1 || got[0].HeadSHA != "abc" || got[1].PR != 3 {
		t.Fatalf("starts = %+v", got)
	}
}

// The whole workflow against a claude Fake and a stubbed patch fetch: the
// verdict lands in modules/touchai and joins back onto a status entry.
func TestTouchAIWorkflowSavesAndJoins(t *testing.T) {
	ta, err := touchai.Open(filepath.Join(t.TempDir(), "touchai.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ta.Close() })
	fake := claude.NewFake()
	fake.SetOutputForPrompt(claude.ModelHaiku, claude.TouchAISystemPrompt,
		`{"impact":"additive","reason":"alleen nieuwe kolommen","summary":"Polissen krijgen een document-URL.","chips":[{"n":1,"verdict":"safe","note":""}]}`)
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, fake, nil, nil, "", "test/repo")
	m.touchai = ta

	orig := fetchTouchedFilesFn
	t.Cleanup(func() { fetchTouchedFilesFn = orig })
	fetchTouchedFilesFn = func(ctx context.Context, repo string, number int, wanted map[string]bool) ([]touchedFile, error) {
		return []touchedFile{{Path: "database/migrations/2026_add.php", Status: "added",
			Patch: "+Schema::table('policies', function (Blueprint $table) {\n+    $table->string('document_url')->nullable();\n+});"}}, nil
	}

	in := TouchAIInput{PR: 13989, HeadSHA: "abc", Files: []string{"database/migrations/2026_add.php"}}
	id := touchAIRunID(in.Repo, in.PR, in.HeadSHA)
	if _, err := engine.StartWorkflowID(id, WorkflowTouchAI, in); err != nil {
		t.Fatal(err)
	}
	raw, ok, err := ta.Get(context.Background(), "", 13989, "abc")
	if err != nil || !ok {
		t.Fatalf("no stored result: ok=%v err=%v", ok, err)
	}
	var res touchAI
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		t.Fatal(err)
	}
	if res.Impact != "additive" || res.Chips["db|policies|+document_url"].Verdict != "safe" {
		t.Fatalf("stored %+v", res)
	}
	st := m.withTouchAI(context.Background(), "", 13989, prStatus{TouchSHA: "abc"})
	if st.TouchAI == nil || st.TouchAI.Summary == "" {
		t.Fatalf("join missing: %+v", st)
	}
	if m.withTouchAI(context.Background(), "", 13989, prStatus{TouchSHA: "newer"}).TouchAI != nil {
		t.Fatal("a result for another head SHA must not join")
	}
}
