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

// TestFailedPostsSurfaceRootAndReply: a root post that failed for good and a
// reply whose mirror failed both show up in TaskManager.FailedPosts (the
// failedPosts half of GET /api/problems); a "repost" of that reply clears it.
func TestFailedPostsSurfaceRootAndReply(t *testing.T) {
	shrinkPostRetryDelays(t)
	m, gh, cs := newTestManager(t)
	ctx := context.Background()

	// 1) A permanent root failure is listed at once.
	gh.SetPostReviewErrs(errors.New("gh: Validation Failed (HTTP 422)"))
	if _, err := m.StartCodeComment(ctx, CodeCommentInput{PR: 42, File: "src/Order.php", Line: 10, Author: "reindert", Body: "why?"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(m.FailedPosts(ctx)) == 1 })
	if f := m.FailedPosts(ctx)[0]; f.ReactionID != "" || f.Error == "" || f.PR != 42 {
		t.Fatalf("root failure row = %+v", f)
	}

	// 2) A posted thread whose reply mirror fails lists that reply too.
	runID, err := m.StartCodeComment(ctx, CodeCommentInput{PR: 43, File: "src/Order.php", Line: 11, Author: "reindert", Body: "and this?"})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 43)
		return len(l) == 1 && l[0].GithubID != 0
	})
	gh.SetReplyErrs(errors.New("gh: Not Found (HTTP 404)"))
	if err := m.Signal(runID, ReactionSignal{ID: "ui-r1", Source: "ui", Author: "me", Body: "ping"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(m.FailedPosts(ctx)) == 2 })
	var reply *struct{ id, body string }
	for _, f := range m.FailedPosts(ctx) {
		if f.ReactionID == "ui-r1" {
			reply = &struct{ id, body string }{f.ReactionID, f.Body}
		}
	}
	if reply == nil || reply.body != "ping" {
		t.Fatalf("reply failure not listed: %+v", m.FailedPosts(ctx))
	}

	// 3) "repost" mirrors it again; once it lands the row is gone.
	if err := m.Signal(runID, ReactionSignal{ID: "ui-r1", Source: "ui", Action: "repost", Body: "ping"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(m.FailedPosts(ctx)) == 1 })
	l, _ := cs.List(ctx, "", 43)
	if len(l[0].Reactions) != 1 || l[0].Reactions[0].GithubID == 0 || l[0].Reactions[0].PostError != "" {
		t.Fatalf("repost did not land cleanly: %+v", l[0].Reactions)
	}
}
