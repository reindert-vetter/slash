package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func shrinkPostRetryDelays(t *testing.T) {
	t.Helper()
	orig := postRetryDelays
	postRetryDelays = []time.Duration{20 * time.Millisecond, 20 * time.Millisecond}
	t.Cleanup(func() { postRetryDelays = orig })
}

// TestCodeCommentPostRetriesTransientFailure: a rate-limited root post is
// recorded on the comment (postError + a scheduled retry) and retried through
// postRetryDelays; once GitHub accepts it the id lands and the error clears.
func TestCodeCommentPostRetriesTransientFailure(t *testing.T) {
	shrinkPostRetryDelays(t)
	m, gh, cs := newTestManager(t)
	ctx := context.Background()
	gh.SetPostReviewErrs(errors.New("gh api GET repos/x/y/pulls/42: exit status 1: gh: API rate limit exceeded for user ID 1. If you reach out to GitHub Support ... (HTTP 403)"))

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{PR: 42, File: "src/Order.php", Line: 10, Author: "reindert", Body: "why?"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].GithubID != 0
	})
	l, _ := cs.List(ctx, "", 42)
	if l[0].PostError != "" || l[0].PostRetryAt != "" {
		t.Fatalf("post error not cleared after a successful retry: %+v", l[0])
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("posted %d, want exactly 1 (no double post)", gh.PostedCount())
	}
}

// TestCodeCommentPostPermanentFailureIsVisibleNotRetried: an HTTP 422 is
// recorded as postError without a retry, and the comment stays unposted.
func TestCodeCommentPostPermanentFailureIsVisibleNotRetried(t *testing.T) {
	shrinkPostRetryDelays(t)
	m, gh, cs := newTestManager(t)
	ctx := context.Background()
	gh.SetPostReviewErrs(errors.New("gh: Validation Failed (HTTP 422)"), errors.New("gh: Validation Failed (HTTP 422)"))

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{PR: 42, File: "src/Order.php", Line: 10, Author: "reindert", Body: "why?"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].PostError != ""
	})
	time.Sleep(100 * time.Millisecond)
	l, _ := cs.List(ctx, "", 42)
	if l[0].GithubID != 0 || l[0].PostRetryAt != "" || gh.PostedCount() != 0 {
		t.Fatalf("a 422 must not be retried: %+v posted=%d", l[0], gh.PostedCount())
	}
}

func TestIsRetryablePostError(t *testing.T) {
	for msg, want := range map[string]bool{
		"gh: API rate limit exceeded for user ID 1 (HTTP 403)":    true,
		"gh: You have exceeded a secondary rate limit (HTTP 403)": true,
		"gh: Bad credentials (HTTP 401)":                          true,
		"dial tcp: lookup api.github.com: no such host":           true,
		"gh: Validation Failed (HTTP 422)":                        false,
		"gh: Not Found (HTTP 404)":                                false,
	} {
		if got := isRetryablePostError(errors.New(msg)); got != want {
			t.Errorf("isRetryablePostError(%q) = %v, want %v", msg, got, want)
		}
	}
}
