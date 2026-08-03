package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"slash/modules/chat"
)

// chat_shadow_test.go covers the git-plumbing halves that don't need gh/
// network access (ensureChatShadowWorktreeAt/commitChatShadowEditsAt), the
// same testability seam ingest.go's own Locked-suffixed functions exist for —
// see TestIngestWorkflowEndToEnd's own doc comment on why fetchPRMeta itself
// (the gh-calling wrapper) has no offline fake and is therefore left
// untested here.
//
// Every test builds its own throwaway "remote" (a bare repo) plus a "local
// clone" it points SLASH_REPO_DIR at, so runGit/runGitIn (both hardwired to
// repoDir()) never touch the real developer clone.

// setupChatShadowRepo creates a bare "origin" repo with one commit on
// headRefName, a local clone of it (used as repoDir() for the duration of the
// test via t.Setenv), and returns the bare repo's path (for advancing origin
// directly, simulating someone else pushing) plus the local clone's path.
func setupChatShadowRepo(t *testing.T, headRefName, fileContent string) (bareDir, cloneDir string) {
	t.Helper()
	root := t.TempDir()
	bareDir = filepath.Join(root, "origin.git")
	seedDir := filepath.Join(root, "seed")
	cloneDir = filepath.Join(root, "clone")

	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
		}
	}

	if err := os.MkdirAll(seedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.Command("git", "init", "--bare", bareDir).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v", err)
	}
	run(seedDir, "init")
	run(seedDir, "config", "user.email", "test@example.com")
	run(seedDir, "config", "user.name", "test")
	run(seedDir, "checkout", "-b", headRefName)
	if err := os.WriteFile(filepath.Join(seedDir, "foo.txt"), []byte(fileContent), 0o644); err != nil {
		t.Fatal(err)
	}
	run(seedDir, "add", "foo.txt")
	run(seedDir, "commit", "-m", "seed")
	run(seedDir, "remote", "add", "origin", bareDir)
	run(seedDir, "push", "origin", headRefName)

	if _, err := exec.Command("git", "clone", bareDir, cloneDir).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v", err)
	}
	run(cloneDir, "config", "user.email", "test@example.com")
	run(cloneDir, "config", "user.name", "test")

	t.Setenv("SLASH_REPO_DIR", cloneDir)
	return bareDir, cloneDir
}

// pushToBare simulates "someone else pushed a new commit" directly onto the
// bare origin's headRefName, independent of anything this test's own shadow
// worktree is doing.
func pushToBare(t *testing.T, bareDir, headRefName, fileContent string) {
	t.Helper()
	tmp := t.TempDir()
	seed := filepath.Join(tmp, "advance")
	if _, err := exec.Command("git", "clone", "--branch", headRefName, bareDir, seed).CombinedOutput(); err != nil {
		t.Fatalf("clone to advance origin: %v", err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", seed}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(seed, "foo.txt"), []byte(fileContent), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "advance")
	run("push", "origin", headRefName)
}

func TestEnsureChatShadowWorktreeCreatesOnFirstUse(t *testing.T) {
	_, cloneDir := setupChatShadowRepo(t, "feature/x", "hello\n")
	_ = cloneDir
	dataDir := t.TempDir()
	ctx := context.Background()

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1001, "conv-a", "feature/x")
	if err != nil {
		t.Fatalf("ensureChatShadowWorktreeAt: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "foo.txt")); err != nil || string(got) != "hello\n" {
		t.Fatalf("shadow content = %q, err %v; want hello\\n", got, err)
	}

	// The worktree is on its own branch, not detached — the whole point of this
	// feature (see .claude/docs/tembed-workflows.md, "claude_chat").
	out, err := exec.Command("git", "-C", dir, "symbolic-ref", "--short", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("symbolic-ref: %v: %s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "chat/conv-a" {
		t.Fatalf("shadow branch = %q, want chat/conv-a (not detached)", got)
	}
}

func TestEnsureChatShadowWorktreeRefreshesWhenClean(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1002, "conv-b", "feature/x")
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}

	// Someone else pushes a new commit to the real PR branch in the meantime.
	pushToBare(t, bareDir, "feature/x", "v2\n")

	dir2, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1002, "conv-b", "feature/x")
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if dir2 != dir {
		t.Fatalf("dir changed: %q vs %q", dir, dir2)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "foo.txt")); string(got) != "v2\n" {
		t.Fatalf("shadow content after refresh = %q, want v2\\n (clean shadow should fast-forward)", got)
	}
}

func TestEnsureChatShadowWorktreeNeverDiscardsPendingEdit(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1003, "conv-c", "feature/x")
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	// Simulate an in-progress Claude edit: an uncommitted change.
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("claude was here\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The real branch moved on in the meantime.
	pushToBare(t, bareDir, "feature/x", "v2\n")

	if _, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1003, "conv-c", "feature/x"); err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "foo.txt"))
	if string(got) != "claude was here\n" {
		t.Fatalf("dirty shadow was overwritten: got %q, want the pending edit preserved", got)
	}
}

// chatShadowLocalPendingState (the shadow-status endpoint's own read) detects
// an uncommitted edit AND a local commit that was never pushed — both purely
// from local git plumbing, no fetch/gh call.
func TestChatShadowLocalPendingStateDetectsDirtyAndAhead(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1004, "conv-d", "feature/x")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}

	if dirty, ahead, err := chatShadowLocalPendingState(ctx, dir); err != nil || dirty || ahead != 0 {
		t.Fatalf("clean shadow reported dirty=%v ahead=%d err=%v, want false/0/nil", dirty, ahead, err)
	}

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("claude was here\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if dirty, _, err := chatShadowLocalPendingState(ctx, dir); err != nil || !dirty {
		t.Fatalf("dirty shadow reported dirty=%v err=%v, want true/nil", dirty, err)
	}

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("add", "-A")
	run("commit", "-m", "local only")
	if dirty, ahead, err := chatShadowLocalPendingState(ctx, dir); err != nil || dirty || ahead != 1 {
		t.Fatalf("committed-but-unpushed shadow reported dirty=%v ahead=%d err=%v, want false/1/nil", dirty, ahead, err)
	}
}

// clearChatShadow proceeds unconditionally once asked — the reviewer already
// saw a pending-work warning (via chatShadowLocalPendingState, the shadow-
// status endpoint) before confirming "wis gesprek" — so it removes the
// worktree + branch even with an uncommitted edit still sitting in it.
func TestClearChatShadowRemovesWorktreeAndBranchEvenWithPendingWork(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1005, "conv-e", "feature/x")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("claude was here\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	clearChatShadow(ctx, nil, dataDir, 1005, "conv-e")

	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("shadow worktree still exists after clear: %v", err)
	}
	out, err := exec.Command("git", "-C", os.Getenv("SLASH_REPO_DIR"), "branch", "--list", "chat/conv-e").CombinedOutput()
	if err != nil {
		t.Fatalf("git branch --list: %v: %s", err, out)
	}
	if strings.TrimSpace(string(out)) != "" {
		t.Fatalf("shadow branch still exists after clear: %q", out)
	}
}

func TestCommitChatShadowEditsPushesFastForward(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1004, "conv-d", "feature/x")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	msg := commitChatShadowEditsAt(ctx, cm, dataDir, 1004, "conv-d", "turn-conv-d", "feature/x")
	if msg.Kind == chat.KindError {
		t.Fatalf("commit reported an error: %+v", msg)
	}

	// Verify the push actually landed on the bare "remote" branch.
	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	got, err := os.ReadFile(filepath.Join(verify, "foo.txt"))
	if err != nil || string(got) != "edited by claude\n" {
		t.Fatalf("pushed content = %q, err %v; want the edit", got, err)
	}

	// Reclaimed: the shadow directory is gone once pushed (see
	// commitChatShadowEditsAt's own reclaim step).
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("shadow worktree not reclaimed after a successful push: err=%v", err)
	}
}

func TestCommitChatShadowEditsRefusesNonFastForward(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 1005, "conv-e", "feature/x")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Someone else pushes to the real branch AFTER the shadow was created but
	// BEFORE the reviewer asks to commit — the classic conflict this feature
	// must never silently force through.
	pushToBare(t, bareDir, "feature/x", "someone else's commit\n")

	msg := commitChatShadowEditsAt(ctx, cm, dataDir, 1005, "conv-e", "turn-conv-e", "feature/x")
	if msg.Kind != chat.KindError {
		t.Fatalf("expected an error message on a non-fast-forward push, got: %+v", msg)
	}

	// The bare repo's branch must be untouched by our attempt (no force-push).
	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	got, err := os.ReadFile(filepath.Join(verify, "foo.txt"))
	if err != nil || string(got) != "someone else's commit\n" {
		t.Fatalf("bare repo content = %q, err %v; want it untouched by the refused push", got, err)
	}
}

func TestCommitChatShadowEditsNothingToCommit(t *testing.T) {
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	// No ensureChatShadowWorktreeAt call at all — no shadow ever existed for
	// this conversation.
	msg := commitChatShadowEditsAt(ctx, cm, dataDir, 1006, "conv-f", "turn-conv-f", "feature/x")
	if msg.Kind != chat.KindError {
		t.Fatalf("expected an informational error for a never-created shadow, got: %+v", msg)
	}
}

// testChatModule returns a throwaway chat.Module backed by an in-memory-ish
// SQLite file under t.TempDir(), for tests that need commitChatShadowEditsAt's
// message-saving side effect but don't care about its content.
func testChatModule(t *testing.T) *chat.Module {
	t.Helper()
	cm, err := chat.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatalf("open chat module: %v", err)
	}
	t.Cleanup(func() { _ = cm.Close() })
	return cm
}
