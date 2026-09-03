package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitRun is these tests' own "do this in that repo" helper — the fixtures in
// chat_checkout_test.go build the repos, this only drives them further.
func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// commitLocally stands in for what Claude does through the Bash carve-out: an
// edit committed in the reviewer's own checkout, on the PR's branch, leaving
// the working tree clean — the exact state whose landing went missing on PR
// 13606 (see chat_land_backstop.go).
func commitLocally(t *testing.T, dir, content string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "commit", "-am", "local edit")
	return gitRun(t, dir, "rev-parse", "HEAD")
}

// assignCheckoutWithBranch registers dir AND the PR's branch as the resolved
// checkout — the backstop needs both (it never guesses a branch name).
func assignCheckoutWithBranch(t *testing.T, pr int, dir, branch string) {
	t.Helper()
	a := getOrCreateCheckoutAssignment("", "", pr)
	a.Dir = dir
	a.Branch = branch
}

func TestUnlandedCheckoutCommitFindsACommitThatNeverLanded(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "hello\n")
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	ctx := context.Background()
	const pr = 1801
	assignCheckoutWithBranch(t, pr, checkout, "feature/x")

	// Nothing local yet: the checkout is exactly origin, so there is nothing
	// to repair.
	if got := unlandedCheckoutCommit(ctx, "", "", pr, "ingested"); got != "" {
		t.Fatalf("clean, unchanged checkout: got %q, want \"\"", got)
	}

	head := commitLocally(t, checkout, "removed\n")
	if got := unlandedCheckoutCommit(ctx, "", "", pr, "ingested"); got != head {
		t.Fatalf("unlanded local commit: got %q, want %q", got, head)
	}

	// The tree already shows this very commit → nothing to do.
	if got := unlandedCheckoutCommit(ctx, "", "", pr, head); got != "" {
		t.Fatalf("already ingested: got %q, want \"\"", got)
	}

	// Once it IS on the pending ref, the ordinary refresh path owns it.
	gitRun(t, repoDir(), "fetch", checkout, head)
	gitRun(t, repoDir(), "update-ref", prPendingRef("", pr, "feature/x"), head)
	if got := unlandedCheckoutCommit(ctx, "", "", pr, "ingested"); got != "" {
		t.Fatalf("already landed: got %q, want \"\"", got)
	}
}

func TestUnlandedCheckoutCommitDeclinesADirtyOrForeignCheckout(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "hello\n")
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	ctx := context.Background()
	const pr = 1802
	assignCheckoutWithBranch(t, pr, checkout, "feature/x")
	head := commitLocally(t, checkout, "removed\n")
	if got := unlandedCheckoutCommit(ctx, "", "", pr, "ingested"); got != head {
		t.Fatalf("precondition: got %q, want %q", got, head)
	}

	// Uncommitted work: may be the reviewer's own, and a landing would
	// `git add -A` it into Claude's commit. Never automatically.
	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := unlandedCheckoutCommit(ctx, "", "", pr, "ingested"); got != "" {
		t.Fatalf("dirty checkout: got %q, want \"\"", got)
	}
	gitRun(t, checkout, "checkout", "--", "foo.txt")

	// Checked out on another branch: whatever HEAD is, it is not this PR's.
	gitRun(t, checkout, "checkout", "-b", "something-else")
	if got := unlandedCheckoutCommit(ctx, "", "", pr, "ingested"); got != "" {
		t.Fatalf("foreign branch: got %q, want \"\"", got)
	}
}

// The read-only half of the same reviewer report: a chat turn must not answer
// "nee, hij staat er nog" out of a head worktree that the checkout has
// already moved past — but it must also not start reading a checkout that is
// BEHIND the tree. See prepareChatReadOnlyWorkDir.
func TestReadOnlyWorkDirPrefersACheckoutThatIsAhead(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "hello\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	const pr = 1803

	_, headDir := worktreeDirs(dataDir, "", pr)
	if err := os.MkdirAll(filepath.Dir(headDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "clone", bareDir, headDir).CombinedOutput(); err != nil {
		t.Fatalf("clone head worktree: %v: %s", err, out)
	}
	gitRun(t, headDir, "checkout", "-B", "feature/x", "origin/feature/x")

	// No checkout assigned at all: unchanged behaviour, the ingested worktree.
	if dir, ok := prepareChatReadOnlyWorkDir(ctx, dataDir, "", pr); !ok || dir != headDir {
		t.Fatalf("no checkout: dir=%q ok=%v, want %q true", dir, ok, headDir)
	}

	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutWithBranch(t, pr, checkout, "feature/x")
	// Same commit on both sides: still the worktree (no locking traded away
	// for nothing).
	if dir, _ := prepareChatReadOnlyWorkDir(ctx, dataDir, "", pr); dir != headDir {
		t.Fatalf("in sync: dir=%q, want the worktree %q", dir, headDir)
	}

	commitLocally(t, checkout, "removed\n")
	if dir, ok := prepareChatReadOnlyWorkDir(ctx, dataDir, "", pr); !ok || dir != checkout {
		t.Fatalf("checkout ahead: dir=%q ok=%v, want %q true", dir, ok, checkout)
	}

	// And the other way around: the tree moved on (a colleague pushed) while
	// this checkout stayed behind — reading it would make answers worse.
	pushToBare(t, bareDir, "feature/x", "colleague\n")
	gitRun(t, headDir, "pull", "--ff-only", "origin", "feature/x")
	if dir, _ := prepareChatReadOnlyWorkDir(ctx, dataDir, "", pr); dir != headDir {
		t.Fatalf("checkout behind: dir=%q, want the worktree %q", dir, headDir)
	}
}
