package main

import "testing"

func TestPlanSalvageAnswerQuestionsCutOff(t *testing.T) {
	cut := "```json\n{\"questions\":[{\"question\":\"Q1?\",\"why\":\"w\",\"options\":[{\"label\":\"A\",\"detail\":\"d\"},{\"label\":\"B\",\"detail\":\"d\"}]},{\"question\":\"Q2?\",\"options\":[{\"label\":\"C\",\"detail\":\"d\",\"blocks\":[{\"code\":\"x = \\\"unfinis"
	qs, _, ok := planSalvageAnswer("questions", cut)
	if !ok || len(qs) != 1 || qs[0].Question != "Q1?" {
		t.Fatalf("salvage = %+v ok=%v", qs, ok)
	}
	if _, _, ok := planSalvageAnswer("questions", `{"questions":[{"question":"Q1?","opt`); ok {
		t.Fatal("nothing complete must not salvage")
	}
	if _, _, ok := planSalvageAnswer("followup", cut); ok {
		t.Fatal("followup must not salvage")
	}
	if planCompactTailFor("questions") == planCompactTailFor("tasks") {
		t.Fatal("questions retry needs its own nudge")
	}
}
