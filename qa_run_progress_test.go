package main

import (
	"testing"

	"slash/modules/claude"
)

func qaTodoSummary(p qaRunProgress) []string {
	out := []string{}
	for _, t := range p.Todos {
		s := t.ID + ":" + t.State
		if t.Result != "" {
			s += ":" + t.Result
		}
		if t.Added {
			s += ":+"
		}
		out = append(out, s)
	}
	return out
}

func eqStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestQARunProgressSinkTodos drives the sink with split deltas, a tool event
// between two text blocks without a trailing newline (the old glue bug), an
// insert-after, the auto-done of a previous doing step and done results.
func TestQARunProgressSinkTodos(t *testing.T) {
	const repo, pr = "test/qa-todos", 991001
	startQARunProgress(repo, pr, "run1")
	sink := qaRunProgressSink(repo, pr)
	text := func(s string) { sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: s}) }
	tool := func() { sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Bash"}) }

	text("Ik ga dit testen.\n[slash:qa-plan] Herinneringen pauzeren en hervatten\n[slash:qa-to")
	text("do] 1 | Opzet: testdata klaarzetten\n[slash:qa-todo] 2 | Pauzeren in de admin\n")
	text("[slash:qa-todo] 3 | Bevindingen") // no trailing newline, block ends
	tool()
	text("[slash:qa-doing] 1") // block ends without newline again
	tool()

	p, _ := qaRunProgressFor(repo, pr)
	if p.Plan != "Herinneringen pauzeren en hervatten" {
		t.Fatalf("plan = %q", p.Plan)
	}
	if got, want := qaTodoSummary(p), []string{"1:doing", "2:todo", "3:todo"}; !eqStrings(got, want) {
		t.Fatalf("todos = %v, want %v", got, want)
	}

	text("[slash:qa-done] 1 ok\n[slash:qa-todo] 2a na 2 | Hervatten na pauze\n")
	text("[slash:qa-doing] 2\n[slash:qa-doing] 2a\n") // 2 auto-done
	text("[slash:qa-done] 2a warn\n[slash:qa-todo] 4 | Regressiecheck\n[slash:qa-done] 3 skip\n")
	text("[slash:qa-done] onbekend fail\n[slash:qa-todo] 1 | Opzet (bijgewerkt)\n")
	tool()

	p, _ = qaRunProgressFor(repo, pr)
	want := []string{"1:done:ok", "2:done:ok", "2a:done:warn:+", "3:done:skip", "4:todo:+"}
	if got := qaTodoSummary(p); !eqStrings(got, want) {
		t.Fatalf("todos = %v, want %v", got, want)
	}
	if p.Todos[0].Title != "Opzet (bijgewerkt)" {
		t.Fatalf("retitle: %q", p.Todos[0].Title)
	}
	if p.Todos[2].Title != "Hervatten na pauze" {
		t.Fatalf("insert title: %q", p.Todos[2].Title)
	}
}

func TestApplyQAMarkerLegacyStepAndBounds(t *testing.T) {
	p := &qaRunProgress{Todos: []qaTodo{}}
	applyQAMarker(p, "qa-step", "Inloggen")
	applyQAMarker(p, "qa-step", "Pauzeren")
	// The first legacy step is not "added" (nothing had started yet).
	if got, want := qaTodoSummary(*p), []string{"step-1:done:ok", "step-2:doing:+"}; !eqStrings(got, want) {
		t.Fatalf("legacy todos = %v, want %v", got, want)
	}
	if len(p.Steps) != 2 {
		t.Fatalf("steps = %v", p.Steps)
	}

	q := &qaRunProgress{Todos: []qaTodo{}}
	applyQAMarker(q, "qa-todo", "zonder pijp")
	applyQAMarker(q, "qa-todo", "id met spatie | x")
	applyQAMarker(q, "qa-todo", "x | ")
	applyQAMarker(q, "qa-todo", "a na onbekend | achteraan")
	if got := qaTodoSummary(*q); !eqStrings(got, []string{"a:todo"}) {
		t.Fatalf("invalid markers: %v", got)
	}
	for i := 0; i < qaMaxTodos+5; i++ {
		applyQAMarker(q, "qa-todo", "n"+string(rune('a'+i%26))+string(rune('a'+i/26))+" | t")
	}
	if len(q.Todos) != qaMaxTodos {
		t.Fatalf("bound: %d", len(q.Todos))
	}
}
