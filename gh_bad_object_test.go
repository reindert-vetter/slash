package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// TestIsBadObjectErr checks the narrow string match retryAfterRefetch's
// callers key off — git's own "fatal: bad object <sha>" wording, the symptom
// reported on plug-and-pay PRs 13535/13628 (see isBadObjectErr's doc comment
// in gh.go).
func TestIsBadObjectErr(t *testing.T) {
	cases := []struct {
		msg  string
		want bool
	}{
		{"", false},
		{"git diff --no-color: exit status 128: fatal: ambiguous argument 'abc': unknown revision", false},
		{"git diff --no-color: exit status 128: fatal: bad object abc123", true},
	}
	for _, c := range cases {
		var err error
		if c.msg != "" {
			err = errString(c.msg)
		}
		if got := isBadObjectErr(err); got != c.want {
			t.Errorf("isBadObjectErr(%q) = %v, want %v", c.msg, got, c.want)
		}
	}
}

type errString string

func (e errString) Error() string { return string(e) }

// TestDiffBetweenSHAsSurfacesErrorAfterRetryingAGenuinelyMissingObject
// exercises diffBetweenSHAs' new retry path end to end against a real local
// repo (no gh, no network, same isolation as
// TestMergeBaseSHAPinsTheBranchPoint): a SHA that was never part of any
// commit does trip isBadObjectErr ("fatal: bad object <sha>", confirmed by
// this test's own log output), so the retry (an explicit re-fetch of both
// SHAs, which fails here because there is no "origin" remote at all) fires —
// and the call still surfaces the original diff failure afterwards instead of
// hanging or silently swallowing it.
func TestDiffBetweenSHAsSurfacesErrorAfterRetryingAGenuinelyMissingObject(t *testing.T) {
	ctx := context.Background()
	repoDir := t.TempDir()
	t.Setenv("SLASH_REPO_DIR", repoDir)
	withShortBadObjectRetry(t)

	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repoDir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	if err := os.WriteFile(repoDir+"/f.txt", []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-m", "c")

	_, err := diffBetweenSHAs(ctx, "", "0000000000000000000000000000000000000000", "HEAD", []string{"f.txt"})
	if err == nil {
		t.Fatal("expected an error for a nonexistent SHA, got nil")
	}
	if !strings.Contains(err.Error(), "bad object") {
		t.Fatalf("unexpected error shape (retry path may have swallowed it): %v", err)
	}
}

// withShortBadObjectRetry shrinks retryAfterRefetch's attempt count/backoff
// for the duration of a test, so a test exercising the retry loop stays fast
// and deterministic instead of sleeping for real (300ms per round).
func withShortBadObjectRetry(t *testing.T) {
	t.Helper()
	prevAttempts, prevBackoff := badObjectRetryAttempts, badObjectRetryBackoff
	badObjectRetryAttempts = 3
	badObjectRetryBackoff = 5 * time.Millisecond
	t.Cleanup(func() {
		badObjectRetryAttempts, badObjectRetryBackoff = prevAttempts, prevBackoff
	})
}

// TestRetryAfterRefetchRetriesMultipleRoundsThenGivesUp asserts the hardened
// behavior added after PR 29 (plug-and-pay-ops): a genuinely unresolvable SHA
// is retried badObjectRetryAttempts times (not just once) with a short
// backoff between rounds, and the final "bad object" error still surfaces
// once every round is exhausted — it must never silently succeed nor hang.
func TestRetryAfterRefetchRetriesMultipleRoundsThenGivesUp(t *testing.T) {
	ctx := context.Background()
	repoDir := t.TempDir()
	t.Setenv("SLASH_REPO_DIR", repoDir)
	withShortBadObjectRetry(t)

	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repoDir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	if err := os.WriteFile(repoDir+"/f.txt", []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-m", "c")

	missing := "0000000000000000000000000000000000000000"
	args := []string{"diff", "--no-color", "--find-renames", "--unified=0", missing, "HEAD", "--", "f.txt"}

	start := time.Now()
	_, err := retryAfterRefetch(ctx, "", missing, "HEAD", args)
	elapsed := time.Since(start)

	if err == nil || !strings.Contains(err.Error(), "bad object") {
		t.Fatalf("expected a surfaced bad-object error, got: %v", err)
	}
	// badObjectRetryAttempts-1 backoffs must have actually happened between
	// rounds — a regression back to a single attempt would finish near-instantly.
	if minElapsed := time.Duration(badObjectRetryAttempts-1) * badObjectRetryBackoff; elapsed < minElapsed {
		t.Fatalf("retryAfterRefetch returned too fast (%v), expected at least %v for %d rounds", elapsed, minElapsed, badObjectRetryAttempts)
	}
}
