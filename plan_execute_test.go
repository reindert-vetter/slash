package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
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

// TestResolvePlanWorkDirPicksTheReviewersWerkmap covers the switch from a
// throwaway data/worktrees/plan-<KEY> worktree to the reviewer's OWN standing
// checkout (resolvePlanWorkDir, plan_execute.go) — the same selection ladder
// the review tree's write turns use. Three behaviours that are easy to break
// and impossible to see from the outside: a clean, registered checkout on the
// base branch IS picked, a dirty one is refused with a reviewer-facing reason
// rather than having the reviewer's uncommitted work dragged onto a new
// branch, and a directory another PR's chat already claims is left alone.
//
// Uses chat_checkout_test.go's own fixtures (a throwaway bare origin plus a
// separate checkout dir), so no real developer clone is ever touched.
func TestResolvePlanWorkDirPicksTheReviewersWerkmap(t *testing.T) {
	base := baseBranchFor("")
	bareDir, _ := setupChatShadowRepo(t, base, "hello\n")
	checkout := cloneCheckoutDir(t, bareDir, base)
	dataDir := t.TempDir()
	writeCheckoutSettings(t, dataDir, checkout)

	dir, note := resolvePlanWorkDir(context.Background(), dataDir)
	if dir != checkout {
		t.Fatalf("clean checkout on %s: got dir %q (note %q), want %q", base, dir, note, checkout)
	}

	// Dirty: never touched, and the reason says so.
	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("local work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir, note = resolvePlanWorkDir(context.Background(), dataDir)
	if dir != "" {
		t.Fatalf("a dirty werkmap must not be used, got %q", dir)
	}
	if !strings.Contains(note, checkout) || !strings.Contains(note, "niet-vastgelegde") {
		t.Fatalf("note must name the dirty werkmap, got %q", note)
	}

	// Clean again, but claimed by another PR's chat: held back, same as in the
	// tree, with a reason that is not the "configure settings.json" dead end.
	if out, err := exec.Command("git", "-C", checkout, "checkout", "--", "foo.txt").CombinedOutput(); err != nil {
		t.Fatalf("git checkout --: %v: %s", err, out)
	}
	assignCheckoutForTest(t, "", 99123, checkout)
	t.Cleanup(func() { assignCheckoutForTest(t, "", 99123, "") })
	dir, note = resolvePlanWorkDir(context.Background(), dataDir)
	if dir != "" {
		t.Fatalf("a werkmap claimed by another PR must not be taken, got %q", dir)
	}
	if !strings.Contains(note, checkout) {
		t.Fatalf("note must name the held-back werkmap, got %q", note)
	}
}
