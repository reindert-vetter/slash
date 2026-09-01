package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The werkmap overlay's live progress panel (src/workDirOverlay.mjs) needs
// the REAL git commands one of the four checkout-menu Activities runs, not
// just a repeated label — see checkout_progress.go's own doc comment. This
// covers the wiring: runGitIn (gh.go) only records a step when its ctx
// carries the withCheckoutProgress marker, so every OTHER runGitIn call site
// in the codebase (ingest worktrees, the re-anchor pass, …) stays unaffected.

func TestCheckoutProgressRecordsGitCommandsOnlyWithMarker(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dir := cloneCheckoutDir(t, bareDir, "feature/x")

	const repo, pr = "", 9101
	clearCheckoutProgress(repo, pr)

	// No marker on ctx: an ordinary runGitIn call (e.g. the ingest pipeline's
	// own use) must not leak a step into this (or any) PR's progress log.
	plainCtx := context.Background()
	if _, err := runGitIn(plainCtx, dir, "status", "--porcelain"); err != nil {
		t.Fatalf("git status: %v", err)
	}
	if steps := checkoutProgressSteps(repo, pr); len(steps) != 0 {
		t.Fatalf("expected no recorded steps without the marker, got %+v", steps)
	}

	// With the marker: a real command (dirty write) and a failing one both
	// land in the log, each with the right outcome.
	progressCtx := withCheckoutProgress(plainCtx, repo, pr)
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := discardCheckoutDirty(progressCtx, dir); err != nil {
		t.Fatalf("discard: %v", err)
	}
	if _, err := runGitIn(progressCtx, dir, "not-a-real-git-subcommand"); err == nil {
		t.Fatal("expected the bogus subcommand to fail")
	}

	steps := checkoutProgressSteps(repo, pr)
	if len(steps) < 3 {
		t.Fatalf("expected at least 3 recorded steps (checkout --, clean -fd, the failing one), got %+v", steps)
	}
	last := steps[len(steps)-1]
	if last.Ok {
		t.Fatalf("expected the last (bogus) command to be recorded as failed, got %+v", last)
	}
	if last.Cmd != "git not-a-real-git-subcommand" {
		t.Fatalf("expected the real command line recorded, got %q", last.Cmd)
	}
	first := steps[0]
	if !first.Ok || first.Cmd == "" {
		t.Fatalf("expected the first (successful) command recorded with its cmd line, got %+v", first)
	}

	// A different PR's log is untouched.
	if steps := checkoutProgressSteps(repo, pr+1); len(steps) != 0 {
		t.Fatalf("expected another pr's progress log to stay empty, got %+v", steps)
	}
}

func TestClearCheckoutProgressResetsTheLog(t *testing.T) {
	const repo, pr = "", 9102
	clearCheckoutProgress(repo, pr)
	appendCheckoutProgressStep(repo, pr, checkoutProgressStep{Cmd: "git status", Ok: true})
	if steps := checkoutProgressSteps(repo, pr); len(steps) != 1 {
		t.Fatalf("expected 1 step before clearing, got %d", len(steps))
	}
	clearCheckoutProgress(repo, pr)
	if steps := checkoutProgressSteps(repo, pr); len(steps) != 0 {
		t.Fatalf("expected the log empty right after clearing, got %+v", steps)
	}
}

func TestCheckoutProgressCapsStepCount(t *testing.T) {
	const repo, pr = "", 9103
	clearCheckoutProgress(repo, pr)
	for i := 0; i < checkoutProgressMaxSteps+10; i++ {
		appendCheckoutProgressStep(repo, pr, checkoutProgressStep{Cmd: "git status", Ok: true, At: int64(i)})
	}
	steps := checkoutProgressSteps(repo, pr)
	if len(steps) != checkoutProgressMaxSteps {
		t.Fatalf("expected the log capped at %d, got %d", checkoutProgressMaxSteps, len(steps))
	}
	// The cap keeps the MOST RECENT steps, not the oldest.
	if steps[len(steps)-1].At != int64(checkoutProgressMaxSteps+9) {
		t.Fatalf("expected the newest step retained, got last At=%d", steps[len(steps)-1].At)
	}
}
