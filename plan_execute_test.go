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

	dir, note := resolvePlanWorkDir(context.Background(), dataDir, "PAYM-1", "paym-1-x", "")
	if dir != checkout {
		t.Fatalf("clean checkout on %s: got dir %q (note %q), want %q", base, dir, note, checkout)
	}

	// Dirty: never touched, and the reason says so.
	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("local work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir, note = resolvePlanWorkDir(context.Background(), dataDir, "PAYM-1", "paym-1-x", "")
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
	dir, note = resolvePlanWorkDir(context.Background(), dataDir, "PAYM-1", "paym-1-x", "")
	if dir != "" {
		t.Fatalf("a werkmap claimed by another PR must not be taken, got %q", dir)
	}
	if !strings.Contains(note, checkout) {
		t.Fatalf("note must name the held-back werkmap, got %q", note)
	}
}

// TestResolvePlanWorkDirReturnsToTheSameWerkmap covers "per plan naar dezelfde
// map": a second execution of the same plan must land in the directory the
// first one used, even though that directory now sits on the plan's own branch
// with a commit origin/<base> does not have — which is exactly what makes the
// selection ladder classify it as somebody else's unfinished work and stop
// offering it (listCheckoutCandidates' diag.Busy). Without the per-plan
// memory the second attempt silently moves to another checkout, or to none.
func TestResolvePlanWorkDirReturnsToTheSameWerkmap(t *testing.T) {
	base := baseBranchFor("")
	bareDir, _ := setupChatShadowRepo(t, base, "hello\n")
	checkout := cloneCheckoutDir(t, bareDir, base)
	dataDir := t.TempDir()
	writeCheckoutSettings(t, dataDir, checkout)

	const key, branch = "PAYM-901", "paym-901-iets"
	dir, note := resolvePlanWorkDir(context.Background(), dataDir, key, branch, "")
	if dir != checkout {
		t.Fatalf("first attempt: got dir %q (note %q), want %q", dir, note, checkout)
	}

	// What the first attempt leaves behind: the plan's branch, one commit
	// ahead of the base branch.
	git := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", append([]string{"-C", checkout}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	git("checkout", "-B", branch, "origin/"+base)
	if err := os.WriteFile(filepath.Join(checkout, "plan.txt"), []byte("done\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-m", "plan")

	// The ladder alone would refuse it now — proving this test is about the
	// per-plan memory and not about a directory that happens to still qualify.
	cands, _ := listCheckoutCandidates(context.Background(), dataDir, repoSlug, base, base, checkoutHoldback{})
	if len(cands) != 0 {
		t.Fatalf("ladder still offers %d candidate(s); fixture no longer exercises the sticky path", len(cands))
	}

	dir, note = resolvePlanWorkDir(context.Background(), dataDir, key, branch, "")
	if dir != checkout {
		t.Fatalf("second attempt: got dir %q (note %q), want the same werkmap %q", dir, note, checkout)
	}

	// Another plan is not dragged into it: it has no memory of its own, so it
	// runs the ladder and correctly finds nothing.
	if dir, _ = resolvePlanWorkDir(context.Background(), dataDir, "PAYM-902", "paym-902-anders", ""); dir != "" {
		t.Fatalf("another plan must not inherit this werkmap, got %q", dir)
	}
}

// TestAdoptPlanCheckoutForPR covers the other half of the reviewer's request —
// "sync met als de chat een aanpassing moet maken vanuit de tree": once the
// draft PR exists, the tree's chat for that PR must already be pointed at the
// werkmap the plan ran in, in memory as well as durably, instead of re-running
// the ladder (which would refuse that very directory, see the test above).
func TestAdoptPlanCheckoutForPR(t *testing.T) {
	dataDir := t.TempDir()
	const pr = 99871
	const dir, branch = "/tmp/plan-werkmap", "paym-903-iets"
	t.Cleanup(func() { assignCheckoutForTest(t, "", pr, "") })

	adoptPlanCheckoutForPR(dataDir, pr, dir, branch)

	a := getCheckoutAssignment(dataDir, "", pr)
	if a == nil || a.Dir != dir || a.Branch != branch {
		t.Fatalf("assignment = %+v, want dir %q branch %q", a, dir, branch)
	}
	if gotDir, gotBranch, ok := loadPersistedCheckout(dataDir, "", pr); !ok || gotDir != dir || gotBranch != branch {
		t.Fatalf("persisted = (%q, %q, %v), want (%q, %q, true)", gotDir, gotBranch, ok, dir, branch)
	}
	// And the directory now counts as claimed, so no other PR's chat can take
	// it while the reviewer is reviewing this draft PR.
	if claims := checkoutDirClaimsByOtherPRs("", 0); claims[dir] != pr {
		t.Fatalf("claims[%q] = %d, want %d", dir, claims[dir], pr)
	}
}

// TestPlanExecutePromptCarriesTheConcreteFields asserts the agent that
// implements the plan sees the concrete half of every task (reviewer request:
// "elke if statement moet in de plan, elke config ook") and the merged work the
// plan was built on.
func TestPlanExecutePromptCarriesTheConcreteFields(t *testing.T) {
	doc := planDoc{
		Key: "PROD-254", Title: "Statistieken",
		RelatedPRs: []planRelatedPR{{Number: 12953, Title: "Clickhouse TTL", URL: "https://github.com/x/y/pull/12953", Files: []string{"app/Stats/Ttl.php"}}},
		Tasks: []planTask{{
			ID: "t1", Title: "Kolom toevoegen", Explanation: "x",
			Location: "app/Stats", Conditions: []string{"als de vlag aan staat"},
			Config: []string{"STATS_TTL=2y"}, Migration: "ALTER TABLE stats_events",
			Endpoints: []string{"GET /api/stats"}, Errors: "log en val terug",
			Rollout: "vlag uit", EdgeCases: []string{"geen rijen"}, OutOfScope: []string{"de frontend"},
		}},
	}
	p := planExecutePrompt(doc)
	for _, want := range []string{
		"AL GEMERGED WERK ROND DIT TICKET", "PR #12953", "app/Stats/Ttl.php",
		"Waar: app/Stats", "Voorwaarden (elke if)", "als de vlag aan staat",
		"Config", "STATS_TTL=2y", "Migratie: ALTER TABLE stats_events",
		"Endpoints", "GET /api/stats", "Foutafhandeling: log en val terug",
		"Uitrol/terugdraaien: vlag uit", "Randgevallen", "geen rijen", "Buiten scope", "de frontend",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt misses %q:\n%s", want, p)
		}
	}
	// A task with nothing filled in writes no labelled lines at all.
	bare := planExecutePrompt(planDoc{Key: "X-1", Tasks: []planTask{{ID: "t1", Title: "Alleen dit"}}})
	if strings.Contains(bare, "Waar:") || strings.Contains(bare, "Randgevallen") {
		t.Fatalf("an empty task must write no detail lines:\n%s", bare)
	}
}
