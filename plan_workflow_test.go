package main

import (
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
