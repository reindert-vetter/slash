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
