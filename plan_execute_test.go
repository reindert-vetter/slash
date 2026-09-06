package main

import (
	"strings"
	"testing"
)

// TestPlanBranchNameIsGitSafe pins the branch name a plan is implemented on:
// the ticket key up front (so `git branch` — and the session-rename hook —
// still finds the Jira key), a bounded slug of the title behind it, and NOTHING
// a git ref may not carry. The name reaches `git`/`gh` as an argument, so this
// is an allow-list, not an escape.
func TestPlanBranchNameIsGitSafe(t *testing.T) {
	cases := []struct {
		key, title, want string
	}{
		{"PAYM-813", "Refund endpoint toevoegen", "paym-813-refund-endpoint-toevoegen"},
		{"PAYM-813", "  Spaces & $ymbols!! ", "paym-813-spaces-ymbols"},
		{"PAYM-813", "", "paym-813"},
		{"PAYM-813", "---", "paym-813"},
		{"PAYM-813", strings.Repeat("a", 200), "paym-813-" + strings.Repeat("a", planExecuteMaxBranchSlug)},
	}
	for _, c := range cases {
		got := planBranchName(c.key, c.title)
		if got != c.want {
			t.Fatalf("planBranchName(%q, %q) = %q, want %q", c.key, c.title, got, c.want)
		}
		if strings.ContainsAny(got, " ~^:?*[\\\"'`$;|&") || strings.Contains(got, "..") {
			t.Fatalf("branch %q carries a character git refuses in a ref", got)
		}
	}
}

// TestPlanExecutePromptCarriesTheWholePlan — the agentic run only ever sees
// this prompt, so the reviewer's FIXED choices and every task (with its example
// code) have to be in it. A block's code is bounded: the document is
// model-authored, and the prompt must stay a bounded function of it.
func TestPlanExecutePromptCarriesTheWholePlan(t *testing.T) {
	doc := planDoc{
		Key:   "PAYM-813",
		Title: "Refund endpoint",
		Questions: []planQuestion{{
			ID: "q1", Question: "Waar hoort dit?",
			Options: []planOption{{ID: "q1o1", Label: "In de service"}, {ID: "q1o2", Label: "In de controller"}},
		}},
		Answers: []planAnswer{{QuestionID: "q1", OptionID: "q1o2", Text: "vanwege de bestaande route"}},
		Tasks: []planTask{{
			ID: "t1", Title: "Endpoint toevoegen", Explanation: "Waarom dit eerst moet",
			Blocks: []planBlock{{
				Title: "app/Foo.php", Lang: "php", Note: "de handler zelf",
				Code:     strings.TrimRight(strings.Repeat("$x = 1;\n", planExecuteMaxBlockLines+10), "\n"),
				Children: []planBlock{{Title: "app/Bar.php", Code: "$y = 2;", Note: "wordt hiervandaan aangeroepen"}},
			}},
		}},
	}

	out := planExecutePrompt(doc)
	for _, want := range []string{
		"PAYM-813", "Refund endpoint",
		"Waar hoort dit?", "In de controller", "vanwege de bestaande route",
		"Endpoint toevoegen", "Waarom dit eerst moet",
		"app/Foo.php", "de handler zelf",
		"app/Bar.php", "wordt hiervandaan aangeroepen",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("prompt is missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "In de service") {
		t.Fatalf("prompt names an option the reviewer did NOT pick:\n%s", out)
	}
	if n := strings.Count(out, "$x = 1;"); n != planExecuteMaxBlockLines {
		t.Fatalf("block code lines = %d, want them capped at %d", n, planExecuteMaxBlockLines)
	}
}

// TestPlanFirstPRURL — the draft PR's address is parsed off `gh pr create`'s
// own stdout, which also carries its progress chatter.
func TestPlanFirstPRURL(t *testing.T) {
	out := "Warning: 3 uncommitted changes\nCreating draft pull request\nhttps://github.com/plug-and-pay/plug-and-pay/pull/13221\n"
	url := planFirstPRURL(out)
	if url != "https://github.com/plug-and-pay/plug-and-pay/pull/13221" {
		t.Fatalf("url = %q", url)
	}
	if n := planPRNumberFromURL(url); n != 13221 {
		t.Fatalf("number = %d, want 13221", n)
	}
	if planFirstPRURL("something went wrong") != "" {
		t.Fatalf("a failure line must not yield a URL")
	}
}
