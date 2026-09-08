package main

import (
	"fmt"
	"strings"
	"testing"
)

// TestParsePlanAnswerNumbersAndCaps pins the two non-obvious rules of the
// plan answer parser: the ids are assigned HERE from the position in the
// answer (never by the model, so a stored answer keeps pointing at the same
// option), and both the question and the option count are capped on our side.
func TestParsePlanAnswerNumbersAndCaps(t *testing.T) {
	raw := "Hier is het plan:\n{\"questions\":[{\"question\":\"Waar hoort dit?\",\"options\":[" +
		"{\"label\":\"In de service\",\"blocks\":[{\"title\":\"app/Foo.php\",\"lang\":\"PHP\",\"code\":\"<?php\\n\",\"children\":[{\"title\":\"app/Bar.php\",\"code\":\"x\"}]}]}," +
		"{\"label\":\"In de controller\"},{\"label\":\"c\"},{\"label\":\"d\"},{\"label\":\"e\"}]}]," +
		"\"tasks\":[{\"title\":\"Endpoint toevoegen\",\"explanation\":\"Waarom\",\"blocks\":[{\"title\":\"api.go\",\"code\":\"y\"}]}]}"

	qs, tasks, err := parsePlanAnswer(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(qs) != 1 || qs[0].ID != "q1" {
		t.Fatalf("questions = %+v, want one question with id q1", qs)
	}
	if len(qs[0].Options) != maxPlanOptions {
		t.Fatalf("options = %d, want them capped at %d", len(qs[0].Options), maxPlanOptions)
	}
	if qs[0].Options[1].ID != "q1o2" {
		t.Fatalf("second option id = %q, want q1o2", qs[0].Options[1].ID)
	}
	b := qs[0].Options[0].Blocks
	if len(b) != 1 || b[0].Lang != "php" || len(b[0].Children) != 1 {
		t.Fatalf("blocks = %+v, want one php block keeping its nested child", b)
	}
	if len(tasks) != 1 || tasks[0].ID != "t1" || tasks[0].Title != "Endpoint toevoegen" {
		t.Fatalf("tasks = %+v", tasks)
	}
}

// TestParsePlanAnswerRejectsJunk — a Claude hiccup (or SLASH_CLAUDE=off, which
// yields "") must be reported, not stored as an empty plan that the page then
// shows as "no questions" forever.
func TestParsePlanAnswerRejectsJunk(t *testing.T) {
	for _, raw := range []string{"", "geen JSON hier", `{"questions":[],"tasks":[]}`} {
		if _, _, err := parsePlanAnswer(raw); err == nil {
			t.Fatalf("parse(%q) = nil error, want a reason", raw)
		}
	}
}

// TestUpsertPlanAnswerReplacesPerQuestion — answering the same question twice
// must not stack two answers, and an empty option with empty text clears it.
func TestUpsertPlanAnswerReplacesPerQuestion(t *testing.T) {
	var list []planAnswer
	list = upsertPlanAnswer(list, PlanAnswerSignal{QuestionID: "q1", OptionID: "q1o1"})
	list = upsertPlanAnswer(list, PlanAnswerSignal{QuestionID: "q2", OptionID: "q2o1", Text: " met caching "})
	list = upsertPlanAnswer(list, PlanAnswerSignal{QuestionID: "q1", OptionID: "q1o2"})
	if len(list) != 2 {
		t.Fatalf("answers = %+v, want one per question", list)
	}
	if list[1].QuestionID != "q1" || list[1].OptionID != "q1o2" {
		t.Fatalf("q1 answer = %+v, want the replacement", list[1])
	}
	if list[0].Text != "met caching" {
		t.Fatalf("text = %q, want it trimmed", list[0].Text)
	}
	list = upsertPlanAnswer(list, PlanAnswerSignal{QuestionID: "q1"})
	for _, a := range list {
		if a.QuestionID == "q1" {
			t.Fatalf("q1 still answered: %+v", list)
		}
	}
}

// TestPlanPromptCarriesAnswers — a regenerate pass must tell Claude which
// choices are already fixed, in words, or it re-asks what was just answered.
func TestPlanPromptCarriesAnswers(t *testing.T) {
	doc := planDoc{
		Key:   "PAYM-813",
		Title: "Iets bouwen",
		Questions: []planQuestion{{ID: "q1", Question: "Waar hoort dit?", Options: []planOption{
			{ID: "q1o1", Label: "In de service"}, {ID: "q1o2", Label: "In de controller"},
		}}},
		Answers: []planAnswer{{QuestionID: "q1", OptionID: "q1o2", Text: "met een facade"}},
	}
	got := planPrompt(doc, "tasks")
	for _, want := range []string{"Waar hoort dit?", "In de controller", "met een facade", `"questions" leeg`} {
		if !strings.Contains(got, want) {
			t.Fatalf("prompt is missing %q:\n%s", want, got)
		}
	}
}

// TestNormalizePlanBlocksKeepsNestedNotes — the per-block explanation is what
// the reviewer reads in a drilled column, so it must survive the trim at EVERY
// nesting level, not only on the top-level block.
func TestNormalizePlanBlocksKeepsNestedNotes(t *testing.T) {
	out := normalizePlanBlocks([]planBlock{{
		Title: "app/Foo.php",
		Note:  " roept de helper aan ",
		Code:  "<?php\n",
		Children: []planBlock{{
			Title:    "app/Support/Bar.php",
			Note:     " de helper zelf ",
			Code:     "<?php\n",
			Children: []planBlock{{Title: "tests/BarTest.php", Note: "dekt de helper", Code: "<?php"}},
		}},
	}})
	if len(out) != 1 || out[0].Note != "roept de helper aan" {
		t.Fatalf("top-level note = %+v", out)
	}
	kid := out[0].Children
	if len(kid) != 1 || kid[0].Note != "de helper zelf" {
		t.Fatalf("child note = %+v", kid)
	}
	if len(kid[0].Children) != 1 || kid[0].Children[0].Note != "dekt de helper" {
		t.Fatalf("grandchild note = %+v", kid[0].Children)
	}
}

// TestPlanPromptCarriesParentAndSubtaskContext — a subtask is planned WITH its
// main task in view but only for itself, and a main task knows which parts are
// already separate tickets. Both sides of that relation must reach the model.
func TestPlanPromptCarriesParentAndSubtaskContext(t *testing.T) {
	sub := planPrompt(planDoc{
		Key: "INTL-145", Title: "Payment link vertalingen",
		ParentKey: "INTL-139", ParentTitle: "Spaans toevoegen",
		ParentDescription: "Alle klantpagina's ook in het Spaans.",
	}, "all")
	for _, want := range []string{"HOOFDTAAK INTL-139: Spaans toevoegen", "Alle klantpagina's ook in het Spaans.", "SUBTAAK"} {
		if !strings.Contains(sub, want) {
			t.Fatalf("subtask prompt misses %q:\n%s", want, sub)
		}
	}
	if strings.Contains(sub, "SUBTAKEN VAN DIT TICKET") {
		t.Fatalf("subtask prompt should not list children:\n%s", sub)
	}

	parent := planPrompt(planDoc{
		Key: "INTL-139", Title: "Spaans toevoegen",
		Subtasks: []planSubtask{
			{Key: "INTL-140", Title: "ES toevoegen aan locales", Status: "In Progress"},
			{Key: "INTL-145", Title: "Payment link vertalingen"},
		},
	}, "all")
	for _, want := range []string{"SUBTAKEN VAN DIT TICKET", "INTL-140: ES toevoegen aan locales (In Progress)", "INTL-145: Payment link vertalingen"} {
		if !strings.Contains(parent, want) {
			t.Fatalf("parent prompt misses %q:\n%s", want, parent)
		}
	}
	if strings.Contains(parent, "HOOFDTAAK") {
		t.Fatalf("parent prompt should carry no parent context:\n%s", parent)
	}
}

// TestPlanNeedsBaseQuestion pins the gate's replay safety: WHICH Executions
// ask the base-branch question. tembed matches history positionally, so an
// Execution that already ran past this point must keep skipping it — its
// recorded planLoadIssue document has no askBase — while one recorded when
// only a bug was asked must keep reaching it via its issue type alone.
func TestPlanNeedsBaseQuestion(t *testing.T) {
	for _, c := range []struct {
		name string
		doc  planDoc
		want bool
	}{
		{"pre-gate story replays past it", planDoc{IssueType: "Story"}, false},
		{"pre-gate document without any type", planDoc{}, false},
		{"bug-only era keeps its gate", planDoc{IssueType: "Bug"}, true},
		{"fresh story asks", planDoc{IssueType: "Story", AskBase: true}, true},
		{"fresh bug asks once", planDoc{IssueType: "Bug", AskBase: true}, true},
		{"fresh document without a type asks", planDoc{AskBase: true}, true},
	} {
		if got := planNeedsBaseQuestion(c.doc); got != c.want {
			t.Fatalf("%s: planNeedsBaseQuestion(%+v) = %v, want %v", c.name, c.doc, got, c.want)
		}
	}
}

// TestPlanRetryMode pins which planGenerate mode a planAnswerRetry Signal
// re-runs: the reported bug was a swallowed parse/timeout error on either the
// FIRST generation (no questions exist yet, so "all" must repeat) or a LATER
// regeneration after an answer (questions already exist and must stay put, so
// only "tasks" repeats) — retrying the wrong one would either silently redo
// questions the reviewer is mid-way through answering, or never produce the
// first round's questions at all.
func TestPlanRetryMode(t *testing.T) {
	for _, c := range []struct {
		name string
		doc  planDoc
		want string
	}{
		{"no questions yet: first generation failed", planDoc{}, "all"},
		{"questions exist: a later regeneration failed", planDoc{Questions: []planQuestion{{ID: "q1"}}}, "tasks"},
	} {
		if got := planRetryMode(c.doc); got != c.want {
			t.Fatalf("%s: planRetryMode(%+v) = %q, want %q", c.name, c.doc, got, c.want)
		}
	}
}

// TestPlanIsBugAndBaseBranch covers the hotfix gate's two pure decisions: WHEN
// a ticket is asked at all (Jira's own issue-type name), and WHICH branch the
// answer settles on. Both drive where plan_execute branches from and which
// branch the draft PR is opened against, and neither is visible from the
// outside once the tracker has moved on.
func TestPlanIsBugAndBaseBranch(t *testing.T) {
	for _, c := range []struct {
		typ  string
		want bool
	}{
		{"Bug", true}, {"bug", true}, {"Bugfix", true}, {"Bug (productie)", true},
		{"Story", false}, {"Sub-task", false}, {"", false},
	} {
		if got := planIsBug(c.typ); got != c.want {
			t.Fatalf("planIsBug(%q) = %v, want %v", c.typ, got, c.want)
		}
	}

	doc := planDoc{DefaultBranch: "develop", HotfixBranch: "master"}
	for _, c := range []struct {
		name       string
		sig        PlanHotfixSignal
		wantHotfix bool
		wantBase   string
	}{
		{"hotfix", PlanHotfixSignal{Hotfix: true}, true, "master"},
		{"ordinary", PlanHotfixSignal{}, false, "develop"},
		{"picked branch", PlanHotfixSignal{Branch: "release/2026-09"}, false, "release/2026-09"},
		{"picked the hotfix branch itself", PlanHotfixSignal{Branch: "master"}, true, "master"},
		{"a branch git would read as a flag", PlanHotfixSignal{Branch: "--exec=rm"}, false, "develop"},
	} {
		gotHotfix, gotBase := resolvePlanBase(doc, c.sig)
		if gotHotfix != c.wantHotfix || gotBase != c.wantBase {
			t.Fatalf("%s: resolvePlanBase = (%v, %q), want (%v, %q)", c.name, gotHotfix, gotBase, c.wantHotfix, c.wantBase)
		}
	}

	// A plan that was never asked (a non-bug, or a document stored before the
	// gate existed) still branches from the repo's own base branch.
	if got := planBaseBranch(planDoc{}); got != baseBranchFor("") {
		t.Fatalf("planBaseBranch(empty) = %q, want %q", got, baseBranchFor(""))
	}
	if got := planBaseBranch(planDoc{BaseBranch: "master"}); got != "master" {
		t.Fatalf("planBaseBranch(master) = %q", got)
	}
}

// TestPlanPromptCarriesTheHotfixConstraint — the hotfix answer is a constraint
// on the PLAN, not only on where the branch is cut: a hotfix goes straight to
// production, so both the planning prompt and the executing one have to say so.
func TestPlanPromptCarriesTheHotfixConstraint(t *testing.T) {
	doc := planDoc{Key: "PAYM-813", Title: "Refund faalt", IssueType: "Bug", Hotfix: true, BaseBranch: "master"}
	for name, out := range map[string]string{"planPrompt": planPrompt(doc, "all"), "planExecutePrompt": planExecutePrompt(doc)} {
		if !strings.Contains(out, "HOTFIX") || !strings.Contains(out, "master") {
			t.Fatalf("%s must name the hotfix and its branch:\n%s", name, out)
		}
	}
	plain := planPrompt(planDoc{Key: "PAYM-813", Title: "Refund faalt", BaseBranch: "develop"}, "all")
	if strings.Contains(plain, "HOTFIX") {
		t.Fatalf("a non-hotfix plan must not be told it is one:\n%s", plain)
	}
}

// TestParseBranchRefsPutsMyBranchesFirst pins the dropdown's ordering rule
// (the reviewer's own branches on top, git's newest-first order kept within
// each group) plus the two refs that must never be offered: origin/HEAD, and
// anything git would not accept back as a ref argument.
func TestParseBranchRefsPutsMyBranchesFirst(t *testing.T) {
	raw := strings.Join([]string{
		"origin/HEAD\t<someone@example.com>\t1 day ago",
		"origin/feature-new\t<other@example.com>\t2 hours ago",
		"origin/my-fix\t<Me@Example.com>\t1 day ago",
		"origin/--evil\t<me@example.com>\t3 days ago",
		"origin/my-older\t<me@example.com>\t4 days ago",
	}, "\n")
	got := parseBranchRefs(raw, "me@example.com")
	var names []string
	for _, b := range got {
		names = append(names, b.Name)
	}
	want := []string{"my-fix", "my-older", "feature-new"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("branches = %v, want %v", names, want)
	}
	if !got[0].Own || got[2].Own {
		t.Fatalf("own flags wrong: %+v", got)
	}
	if got[0].Updated != "1 day ago" {
		t.Fatalf("updated = %q", got[0].Updated)
	}
}

// TestPlanRelatedKeysIsTheFamilyInTierOrder pins the order the ticket family is
// searched in — this ticket, its main task, then the subtasks/siblings around
// it — because that order IS the relevance tier rankPlanRelatedPRs uses.
func TestPlanRelatedKeysIsTheFamilyInTierOrder(t *testing.T) {
	doc := planDoc{
		Key:       "PAYM-813",
		ParentKey: "PAYM-800",
		Subtasks:  []planSubtask{{Key: "PAYM-814"}, {Key: "PAYM-813"}, {Key: "not a key"}},
		Siblings:  []planSubtask{{Key: "PAYM-801"}, {Key: "PAYM-814"}},
	}
	got := planRelatedKeys(doc)
	want := []string{"PAYM-813", "PAYM-800", "PAYM-814", "PAYM-801"}
	if len(got) != len(want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("keys = %v, want %v", got, want)
		}
	}
}

// TestRankPlanRelatedPRsPicksTheThreeMostRelevant covers the reviewer's own
// wording: "als dat meer dan 3 prs zijn, moet je de 3 meest relevante prs
// vinden". Own ticket beats main task beats subtask, newest merged wins within
// a tier, and one PR found twice counts once (under its best tier).
func TestRankPlanRelatedPRsPicksTheThreeMostRelevant(t *testing.T) {
	keys := []string{"PAYM-813", "PAYM-800", "PAYM-814"}
	list := []planRelatedPR{
		{Number: 1, Key: "PAYM-814", MergedAt: "2026-01-01T00:00:00Z"},
		{Number: 2, Key: "PAYM-800", MergedAt: "2026-02-01T00:00:00Z"},
		{Number: 3, Key: "PAYM-813", MergedAt: "2026-01-01T00:00:00Z"},
		{Number: 4, Key: "PAYM-813", MergedAt: "2026-03-01T00:00:00Z"},
		{Number: 2, Key: "PAYM-814", MergedAt: "2026-02-01T00:00:00Z"},
		{Number: 5, Key: "PAYM-800", MergedAt: "2026-05-01T00:00:00Z"},
	}
	got := rankPlanRelatedPRs(list, keys)
	if len(got) != maxPlanRelatedPRs {
		t.Fatalf("got %d PRs, want %d: %+v", len(got), maxPlanRelatedPRs, got)
	}
	if got[0].Number != 4 || got[1].Number != 3 {
		t.Fatalf("own-ticket PRs first, newest first: %+v", got)
	}
	if got[2].Number != 5 || got[2].Key != "PAYM-800" {
		t.Fatalf("third = %+v, want the newest main-task PR", got[2])
	}
}

// TestPlanPromptCarriesCommentsAndMergedWork asserts the two context sections
// the reviewer asked for really reach the model, including the rule that a
// later comment outranks the description.
func TestPlanPromptCarriesCommentsAndMergedWork(t *testing.T) {
	doc := planDoc{
		Key: "PROD-254", Title: "Statistieken", Description: "Moet blijven werken",
		Comments:        []planComment{{Author: "Reindert", Created: "2026-09-04", Body: "hoeft dus niet"}},
		RelatedComments: []planComment{{Key: "PROD-200", Author: "Dennis", Body: "kolom toevoegen"}},
		RelatedPRs: []planRelatedPR{
			{Number: 12953, Title: "Clickhouse TTL", Key: "PROD-200", MergedAt: "2026-07-14T13:43:23Z", Files: []string{"app/Stats/Ttl.php"}},
		},
	}
	p := planPrompt(doc, "all")
	for _, want := range []string{
		"OPMERKINGEN OP DIT TICKET", "hoeft dus niet",
		"OPMERKINGEN OP DE HOOFDTAAK EN DE SUBTAKEN", "PROD-200 · Dennis", "kolom toevoegen",
		"ZWAARDER",
		"AL GEMERGED WERK", "PR #12953: Clickhouse TTL", "app/Stats/Ttl.php", "Bouw hierop VOORT",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt misses %q:\n%s", want, p)
		}
	}
}

// TestPlanPromptDemandsEveryIfAndConfig pins the reviewer's own rule — "elke if
// statement moet in de plan, elke config ook" — plus the rest of the agreed
// checklist, and the deliberate absence of tests.
func TestPlanPromptDemandsEveryIfAndConfig(t *testing.T) {
	p := planPrompt(planDoc{Key: "PAYM-813", Title: "Refund"}, "all")
	for _, want := range []string{
		"ELKE if/voorwaarde", "ELKE config", `"location"`, `"migration"`, `"endpoints"`,
		`"errors"`, `"rollout"`, `"edgeCases"`, `"outOfScope"`,
		"Stel GEEN vragen over tests", "Noem GEEN tests",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt misses %q:\n%s", want, p)
		}
	}
}

// TestPlanFollowupPromptAsksForNewQuestions covers the follow-up round: the
// questions already asked are listed as off-limits, and the task list is left
// to the separate regeneration step right after it.
func TestPlanFollowupPromptAsksForNewQuestions(t *testing.T) {
	doc := planDoc{Key: "PAYM-813", Title: "Refund", Questions: []planQuestion{{ID: "q1", Question: "Welke gateway?"}}}
	p := planPrompt(doc, "followup")
	for _, want := range []string{"VRAGEN DIE AL GESTELD ZIJN", "Welke gateway?", "VERVOLGVRAGEN", `Laat "tasks" leeg`} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt misses %q:\n%s", want, p)
		}
	}
}

// TestAppendPlanQuestionsNumbersAfterTheExistingOnes is the load-bearing half
// of the follow-up round: the reviewer's stored answers hang off the existing
// ids, so those may never move — the new questions continue the numbering, a
// literal repeat is dropped, and the total stays bounded.
func TestAppendPlanQuestionsNumbersAfterTheExistingOnes(t *testing.T) {
	existing := []planQuestion{
		{ID: "q1", Question: "Welke gateway?", Options: []planOption{{ID: "q1o1", Label: "Mollie"}}},
		{ID: "q2", Question: "Wanneer?", Options: []planOption{{ID: "q2o1", Label: "Nu"}}},
	}
	fresh := []planQuestion{
		{ID: "q1", Question: "welke gateway?", Options: []planOption{{ID: "q1o1", Label: "dubbel"}}},
		{ID: "q2", Question: "Welke feature flag?", Options: []planOption{{ID: "q2o1", Label: "aan"}, {ID: "q2o2", Label: "uit"}}},
	}
	got := appendPlanQuestions(existing, fresh)
	if len(got) != 3 {
		t.Fatalf("questions = %d, want the two existing plus one new: %+v", len(got), got)
	}
	if got[0].ID != "q1" || got[1].ID != "q2" || got[0].Options[0].ID != "q1o1" {
		t.Fatalf("existing questions moved: %+v", got)
	}
	if got[2].ID != "q3" || got[2].Question != "Welke feature flag?" {
		t.Fatalf("new question = %+v, want q3", got[2])
	}
	if got[2].Options[0].ID != "q3o1" || got[2].Options[1].ID != "q3o2" {
		t.Fatalf("new options = %+v", got[2].Options)
	}
	// The total is bounded however many rounds are asked for.
	big := make([]planQuestion, 0, maxPlanQuestionsTotal+3)
	for i := 0; i < maxPlanQuestionsTotal+3; i++ {
		big = append(big, planQuestion{Question: fmt.Sprintf("v%d", i)})
	}
	if capped := appendPlanQuestions(nil, big); len(capped) != maxPlanQuestionsTotal {
		t.Fatalf("capped = %d, want %d", len(capped), maxPlanQuestionsTotal)
	}
}

// TestParsePlanAnswerKeepsTheConcreteTaskFields asserts the concrete half of a
// task survives parsing, trimmed and bounded (see planTask).
func TestParsePlanAnswerKeepsTheConcreteTaskFields(t *testing.T) {
	raw := `{"questions":[],"tasks":[{"title":"Kolom toevoegen","explanation":"x",
		"location":" app/Stats ","conditions":["als de vlag aan staat","","als hij uit staat"],
		"config":["STATS_TTL=2y (default 30d)"],"migration":"ALTER TABLE stats_events",
		"endpoints":["GET /api/stats"],"errors":"faalt de query, log en val terug",
		"rollout":"achter STATS_TTL, terugdraaien = vlag uit","edgeCases":["geen rijen","heel veel rijen"],
		"outOfScope":["de frontend"]}]}`
	_, tasks, err := parsePlanAnswer(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	task := tasks[0]
	if task.Location != "app/Stats" {
		t.Fatalf("location = %q", task.Location)
	}
	if len(task.Conditions) != 2 || task.Conditions[0] != "als de vlag aan staat" {
		t.Fatalf("conditions = %+v, want the empty one dropped", task.Conditions)
	}
	if task.Migration == "" || task.Errors == "" || task.Rollout == "" ||
		len(task.Config) != 1 || len(task.Endpoints) != 1 || len(task.EdgeCases) != 2 || len(task.OutOfScope) != 1 {
		t.Fatalf("task = %+v", task)
	}
	// Bounded: a model that lists twenty conditions is cut, not rendered whole.
	many := make([]string, 0, maxPlanDetailItems+4)
	for i := 0; i < maxPlanDetailItems+4; i++ {
		many = append(many, fmt.Sprintf("c%d", i))
	}
	if got := normalizePlanDetails(many); len(got) != maxPlanDetailItems {
		t.Fatalf("details = %d, want %d", len(got), maxPlanDetailItems)
	}
	if normalizePlanDetails([]string{" ", ""}) != nil {
		t.Fatalf("an all-empty list must yield nil")
	}
}

// TestPlanChatPromptCarriesContextAndTranscript — the general chat about a
// ticket (reused from the review tree, see .claude/docs/plan-page.md) must
// discuss the SAME facts the plan itself was built from, not a second,
// drifted picture: the ticket, the answers so far, the task list, and the
// conversation itself (ending on the reviewer's own last message).
func TestPlanChatPromptCarriesContextAndTranscript(t *testing.T) {
	doc := planDoc{
		Key:   "PAYM-813",
		Title: "Iets bouwen",
		Tasks: []planTask{{ID: "t1", Title: "De service aanpassen"}},
		Chat: []planChatMessage{
			{Role: "user", Body: "Waarom kiezen we hier voor een facade?"},
		},
	}
	got := planChatPrompt(doc)
	for _, want := range []string{"PAYM-813", "Iets bouwen", "De service aanpassen", "Waarom kiezen we hier voor een facade?", "Reviewer:"} {
		if !strings.Contains(got, want) {
			t.Fatalf("chat prompt is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, `"questions"`) {
		t.Fatalf("chat prompt must ask for prose, not the plan's own JSON shape:\n%s", got)
	}
}

// TestTrimPlanChatBounds — the transcript is capped so neither the prompt nor
// the page grows unbounded, keeping the NEWEST messages. Built from complete
// (user, assistant) pairs, the shape every real turn appends, so the kept
// window still starts on a user turn.
func TestTrimPlanChatBounds(t *testing.T) {
	var list []planChatMessage
	for i := 0; i < (maxPlanChatMessages+6)/2; i++ {
		list = append(list,
			planChatMessage{Role: "user", Body: fmt.Sprintf("q%d", i)},
			planChatMessage{Role: "assistant", Body: fmt.Sprintf("a%d", i)},
		)
	}
	got := trimPlanChat(list)
	if len(got) > maxPlanChatMessages {
		t.Fatalf("trimmed length = %d, want at most %d", len(got), maxPlanChatMessages)
	}
	if got[0].Role != "user" {
		t.Fatalf("first kept message = %+v, want it to start on a user turn", got[0])
	}
	last := list[len(list)-1]
	if got[len(got)-1] != last {
		t.Fatalf("last kept message = %+v, want the newest %+v", got[len(got)-1], last)
	}
	// A list already within bounds is untouched.
	small := []planChatMessage{{Role: "user", Body: "hoi"}}
	if got := trimPlanChat(small); len(got) != 1 {
		t.Fatalf("a short list should not be trimmed: %+v", got)
	}
}

// TestPlanTaskStateFoldAndRegeneration covers the whole of task 22's backend:
// the checkbox/note fold is a pure function of the recorded Signal, an
// unchecked task never comes back from a regeneration but keeps its row (so it
// can be ticked again), and the off-list reaches the prompt. The keying is by
// TITLE on purpose — a task id is positional and every regeneration renumbers
// the list — which is exactly what makes this worth a regression test.
func TestPlanTaskStateFoldAndRegeneration(t *testing.T) {
	var states []planTaskState
	// Default: nothing stored, everything ticked.
	if !planTaskEnabled(states, "Voeg de checkbox toe") {
		t.Fatalf("a task with no stored state must default to CHECKED")
	}
	// A note alone is stored; the checkbox stays on.
	states = upsertPlanTaskState(states, PlanAnswerSignal{Kind: planAnswerTask, TaskTitle: "Voeg de checkbox toe", TaskNote: "  gebruik de tree-weergave  "})
	if len(states) != 1 || states[0].Note != "gebruik de tree-weergave" || states[0].Off {
		t.Fatalf("note-only state wrong: %+v", states)
	}
	// The same task again, now unchecked — one row per task, never two.
	states = upsertPlanTaskState(states, PlanAnswerSignal{Kind: planAnswerTask, TaskTitle: "VOEG de   checkbox toe", TaskOff: true})
	if len(states) != 1 || !states[0].Off {
		t.Fatalf("expected one unchecked state (title matched case/whitespace-insensitively): %+v", states)
	}
	if planTaskEnabled(states, "voeg de checkbox toe") {
		t.Fatalf("an unchecked task must not read as enabled")
	}
	// Back to the default (checked, no note) drops the row again.
	settled := upsertPlanTaskState(states, PlanAnswerSignal{Kind: planAnswerTask, TaskTitle: "Voeg de checkbox toe"})
	if len(settled) != 0 {
		t.Fatalf("a state back at the default must be removed, got %+v", settled)
	}

	prev := []planTask{{ID: "t1", Title: "Voeg de checkbox toe"}, {ID: "t2", Title: "Toon de huidige code"}}
	// The regeneration answers with the unchecked task again (models do) plus a
	// new one: the unchecked one must not reappear in the plan, but its row
	// must survive at the end so the checkbox is still there.
	fresh := []planTask{{ID: "t1", Title: "Voeg de checkbox toe"}, {ID: "t2", Title: "Toon de huidige code"}, {ID: "t3", Title: "Werk de docs bij"}}
	got := mergePlanTasks(fresh, prev, states)
	if len(got) != 3 {
		t.Fatalf("expected 3 tasks (2 kept + the unchecked one re-appended), got %d: %+v", len(got), got)
	}
	if got[0].Title != "Toon de huidige code" || got[1].Title != "Werk de docs bij" {
		t.Fatalf("the enabled tasks must come first, in the generated order: %+v", got)
	}
	if got[2].Title != "Voeg de checkbox toe" {
		t.Fatalf("the unchecked task must be re-appended last, got %+v", got[2])
	}
	for i, tk := range got {
		if want := fmt.Sprintf("t%d", i+1); tk.ID != want {
			t.Fatalf("ids must be renumbered across the result: task %d is %q, want %q", i, tk.ID, want)
		}
	}
	// Duplicated exactly once, even when it survives several rounds.
	again := mergePlanTasks(fresh, got, states)
	if len(again) != 3 {
		t.Fatalf("a second regeneration must not duplicate the unchecked task: %+v", again)
	}

	// The prompt tells the model to leave it out.
	doc := planDoc{Key: "PAYM-1", Title: "Titel", Description: "Omschrijving", TaskStates: states}
	p := planPrompt(doc, "tasks")
	if !strings.Contains(p, "UITGEVINKT") || !strings.Contains(p, "VOEG de   checkbox toe") {
		t.Fatalf("the tasks prompt must list the unchecked tasks as off-limits:\n%s", p)
	}
}

// TestPlanExecutePromptSkipsUncheckedTasksAndCarriesTheNote is the other half:
// only ticked tasks are executed, and the reviewer's own field travels along.
func TestPlanExecutePromptSkipsUncheckedTasksAndCarriesTheNote(t *testing.T) {
	doc := planDoc{
		Key:   "PAYM-1",
		Title: "Titel",
		Tasks: []planTask{{ID: "t1", Title: "Doe dit"}, {ID: "t2", Title: "Doe dat niet"}},
		TaskStates: []planTaskState{
			{Key: planTaskKey("Doe dat niet"), Title: "Doe dat niet", Off: true},
			{Key: planTaskKey("Doe dit"), Title: "Doe dit", Note: "let op de rechten"},
		},
	}
	p := planExecutePrompt(doc)
	if !strings.Contains(p, "1. Doe dit") {
		t.Fatalf("the ticked task must be in the prompt:\n%s", p)
	}
	if strings.Contains(p, "Doe dat niet") {
		t.Fatalf("an unchecked task must NOT reach the execute prompt:\n%s", p)
	}
	if !strings.Contains(p, "let op de rechten") {
		t.Fatalf("the reviewer's own field must travel to the execution:\n%s", p)
	}
	if !planHasEnabledTask(doc) {
		t.Fatalf("planHasEnabledTask must be true while one task is still ticked")
	}
	doc.TaskStates = append(doc.TaskStates, planTaskState{Key: planTaskKey("Doe dit"), Title: "Doe dit", Off: true})
	// The later state wins in a lookup, so with both unchecked there is nothing
	// to run and the workflow says so instead of opening an empty draft PR.
	doc.TaskStates[1].Off = true
	if planHasEnabledTask(doc) {
		t.Fatalf("with every task unchecked there must be nothing to execute")
	}
	if titles := planTaskTitles(doc); len(titles) != 0 {
		t.Fatalf("the PR body must only list ticked tasks, got %v", titles)
	}
}
