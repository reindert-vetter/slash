package main

import (
	"slices"
	"testing"
)

func TestPlanChatToolsetShellHasNoEdit(t *testing.T) {
	tools := planChatToolset(true, "/x/identifier.db", false)
	for _, want := range []string{"Read", "Grep", "Glob", "Bash", "mcp__playwright", "mcp__laravel-boost"} {
		if !slices.Contains(tools, want) {
			t.Errorf("missing %s in %v", want, tools)
		}
	}
	if slices.Contains(tools, "Edit") {
		t.Errorf("the plan chat must never get Edit: %v", tools)
	}
}

func TestPlanChatToolsetWithoutWerkmapGetsNoShell(t *testing.T) {
	tools := planChatToolset(false, "/x/identifier.db", true)
	want := []string{"Read", "Bash(duckdb -readonly /x/identifier.db:*)"}
	if !slices.Equal(tools, want) {
		t.Errorf("got %v want %v", tools, want)
	}
	if got := planChatToolset(false, "", false); len(got) != 0 {
		t.Errorf("got %v want none", got)
	}
}
