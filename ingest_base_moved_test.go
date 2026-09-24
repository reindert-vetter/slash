package main

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

// TestIngestBaseMovedDetectsTargetBranchChange pins the fix for PR 13810: its
// target branch was changed on GitHub (to a feature branch the head had merged
// in) while the head itself did not move, and the review tree kept diffing
// against the old merge base — showing the target branch's own changes as the
// PR's. ingestBaseMoved must see that from local git alone, and must NOT fire
// when the new target does not change the merge base (nothing to redo) or the
// live base commit can't be resolved (never re-ingest on every tick).
func TestIngestBaseMovedDetectsTargetBranchChange(t *testing.T) {
	cloneDir, developSHA := setupDevelopRepo(t)
	ctx := context.Background()
	git := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", cloneDir}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}

	// The future target branch, off develop, pushed to origin.
	git("checkout", "-b", "feature/target", developSHA)
	targetSHA := commitPHPFile(t, cloneDir, "app/Target.php", "target", "target change")
	git("push", "origin", "feature/target")

	// The PR branch, off develop too; ingested with base = develop.
	git("checkout", "-b", "feature/pr", developSHA)
	prHead := commitPHPFile(t, cloneDir, "app/Pr.php", "pr", "pr change")

	if ingestBaseMoved(ctx, "", developSHA, developSHA, prHead) {
		t.Fatal("same live and stored base: want false")
	}
	// Target switched, but the head doesn't contain it: the merge base is
	// still develop's commit, exactly what GitHub itself diffs against.
	if ingestBaseMoved(ctx, "", targetSHA, developSHA, prHead) {
		t.Fatal("target changed without moving the merge base: want false")
	}

	// The head merged the new target (PR 13810's "Merge PROD-439" commit):
	// the merge base is now the target tip, the stored develop base is stale.
	git("merge", "--no-ff", "-m", "merge target", "feature/target")
	mergedHead := git("rev-parse", "HEAD")
	if !ingestBaseMoved(ctx, "", targetSHA, developSHA, mergedHead) {
		t.Fatal("head absorbed the new target: want true")
	}
	// Converges: once the merge base is stored, nothing is left to redo.
	if ingestBaseMoved(ctx, "", targetSHA, targetSHA, mergedHead) {
		t.Fatal("stored base already the merge base: want false")
	}
	if ingestBaseMoved(ctx, "", "1234567890123456789012345678901234567890", developSHA, mergedHead) {
		t.Fatal("unresolvable live base: want false")
	}

	// The PR's file set is taken against ITS target branch: against develop
	// the merged-in target file would wrongly count as a PR file.
	files, err := prLocalChangedFilePaths(ctx, "", "feature/target", mergedHead)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(files, ",") != "app/Pr.php" {
		t.Fatalf("files vs target = %v, want [app/Pr.php]", files)
	}
	wide, err := prLocalChangedFilePaths(ctx, "", "", mergedHead)
	if err != nil {
		t.Fatal(err)
	}
	if len(wide) != 2 {
		t.Fatalf("files vs default develop = %v, want both files", wide)
	}
}
