package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestMergeBaseSHAPinsTheBranchPoint is the regression guard for a
// reviewer-reported bug: a translation key that was added to develop AFTER a PR
// branched off showed up as a DELETED line in that PR's diff. Cause was the
// ingest taking its base from `gh pr view --json baseRefOid` — the current tip
// of the base branch — so the two-dot diff also reported everything develop
// gained meanwhile, inverted, as removals. Fix is to diff from the merge base,
// like GitHub's own "Files changed" does.
//
// No gh, no network: SLASH_REPO_DIR points at a throwaway local repo (the same
// isolation chat_merge_test.go uses).
func TestMergeBaseSHAPinsTheBranchPoint(t *testing.T) {
	ctx := context.Background()
	repoDir := t.TempDir()
	t.Setenv("SLASH_REPO_DIR", repoDir)

	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repoDir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	head := func() string {
		t.Helper()
		out, err := exec.Command("git", "-C", repoDir, "rev-parse", "HEAD").Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	const path = "nl.json"
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repoDir, path), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		git("add", "-A")
		git("commit", "-m", "c")
	}

	git("init", "-q", "-b", "develop")
	// The branch point: neither of the two later keys exists yet.
	write("{\n  \"collect\": \"Incasseren\"\n}\n")
	branchPoint := head()

	// The PR's own branch adds a key of its own.
	git("checkout", "-q", "-b", "feature")
	write("{\n  \"collect\": \"Incasseren\",\n  \"huddle_level\": \"Toegangsniveau\"\n}\n")
	prHead := head()

	// Meanwhile develop moves on with a key the PR never saw.
	git("checkout", "-q", "develop")
	write("{\n  \"collect\": \"Incasseren\",\n  \"collect_cooldown\": \"Even wachten\"\n}\n")
	developTip := head()

	if got := mergeBaseSHA(ctx, "", developTip, prHead); got != branchPoint {
		t.Fatalf("merge base = %s, want the branch point %s", got, branchPoint)
	}
	// Idempotent: refreshIngestDelta re-resolves an already-stored merge base.
	if got := mergeBaseSHA(ctx, "", branchPoint, prHead); got != branchPoint {
		t.Fatalf("re-resolving the merge base changed it: %s", got)
	}

	// The bug and its absence, on the diff the ingest actually parses.
	fromTip, err := diffBetweenSHAs(ctx, "", developTip, prHead, []string{path})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fromTip, "-  \"collect_cooldown\"") {
		t.Fatalf("expected the two-dot diff to show the phantom deletion, got:\n%s", fromTip)
	}
	fromBase, err := diffBetweenSHAs(ctx, "", mergeBaseSHA(ctx, "", developTip, prHead), prHead, []string{path})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fromBase, "collect_cooldown") {
		t.Fatalf("a develop-only key must not appear in the PR's diff at all, got:\n%s", fromBase)
	}
	if !strings.Contains(fromBase, "+  \"huddle_level\"") {
		t.Fatalf("the PR's own addition went missing, got:\n%s", fromBase)
	}
}
