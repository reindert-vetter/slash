package main

import "testing"

// helper to build one review submission for the fixtures below.
func rev(login, state, submittedAt string) reviewNode {
	n := reviewNode{State: state, SubmittedAt: submittedAt}
	n.Author.Login = login
	return n
}

// helper to build the "ground truth" latestReviews entry the fold is
// cross-checked against.
func latest(login, state string) struct {
	State  string `json:"state"`
	Author struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatarUrl"`
	} `json:"author"`
} {
	e := struct {
		State  string `json:"state"`
		Author struct {
			Login     string `json:"login"`
			AvatarURL string `json:"avatarUrl"`
		} `json:"author"`
	}{State: state}
	e.Author.Login = login
	return e
}

// stateOf looks up the merged state for a login in mergeReviewers' output.
func stateOf(t *testing.T, reviewers []reviewer, login string) string {
	t.Helper()
	for _, r := range reviewers {
		if r.Login == login {
			return r.State
		}
	}
	t.Fatalf("reviewer %q not found in %+v", login, reviewers)
	return ""
}

// TestMergeReviewersDecisiveFold covers the core bug this fix addresses:
// GitHub's `latestReviews` field returns literally "the very last review
// submitted, whatever its type" — mergeReviewers must instead fold each
// author's history to their last DECISIVE (APPROVED/CHANGES_REQUESTED/
// DISMISSED) state, since a plain COMMENTED review afterwards never revokes
// an earlier approval (mirrors GitHub's own reviewDecision/sidebar
// behavior).
func TestMergeReviewersDecisiveFold(t *testing.T) {
	cases := []struct {
		name string
		revs []reviewNode
		want string // expected merged state for author "alice"
	}{
		{
			name: "approve then comment: approval survives",
			revs: []reviewNode{
				rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
				rev("alice", "COMMENTED", "2026-01-01T09:05:00Z"),
			},
			want: "APPROVED",
		},
		{
			name: "approve then changes-requested: it DOES flip",
			revs: []reviewNode{
				rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
				rev("alice", "CHANGES_REQUESTED", "2026-01-01T09:05:00Z"),
			},
			want: "CHANGES_REQUESTED",
		},
		{
			name: "only ever commented: stays commented",
			revs: []reviewNode{
				rev("alice", "COMMENTED", "2026-01-01T09:00:00Z"),
			},
			want: "COMMENTED",
		},
		{
			name: "approve then dismissed: the dismissal wins",
			revs: []reviewNode{
				rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
				rev("alice", "DISMISSED", "2026-01-01T09:05:00Z"),
			},
			want: "DISMISSED",
		},
		{
			name: "approve, dismissed, approved again: the fresh approval wins",
			revs: []reviewNode{
				rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
				rev("alice", "DISMISSED", "2026-01-01T09:05:00Z"),
				rev("alice", "APPROVED", "2026-01-01T09:10:00Z"),
			},
			want: "APPROVED",
		},
		{
			name: "changes-requested then a later comment: still blocked",
			revs: []reviewNode{
				rev("alice", "CHANGES_REQUESTED", "2026-01-01T09:00:00Z"),
				rev("alice", "COMMENTED", "2026-01-01T09:05:00Z"),
			},
			want: "CHANGES_REQUESTED",
		},
		{
			name: "reviews arrive out of chronological order: still folds correctly",
			revs: []reviewNode{
				// COMMENTED node listed BEFORE the APPROVED one in the slice,
				// but its own submittedAt is LATER — the defensive sort in
				// foldReviewerStates must still process APPROVED first.
				rev("alice", "COMMENTED", "2026-01-01T09:05:00Z"),
				rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
			},
			want: "APPROVED",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var n ghPRNode
			n.Reviews.Nodes = tc.revs
			// The ground truth (latestReviews) always matches the raw state
			// of the chronologically last review in these fixtures — none of
			// these cases involve truncation.
			last := tc.revs[len(tc.revs)-1]
			n.LatestReviews.Nodes = append(n.LatestReviews.Nodes, latest("alice", last.State))

			got := stateOf(t, mergeReviewers(n), "alice")
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// TestMergeReviewersTruncation covers the reviewsPerPRCap pagination
// boundary: once a PR has more review submissions than we fetched (oldest-
// first, so the newest ones are exactly what's missing), mergeReviewers must
// not silently guess — only trust the fold when it can prove, via the
// separate/always-complete latestReviews field, that nothing relevant to
// that specific author was cut off.
func TestMergeReviewersTruncation(t *testing.T) {
	t.Run("truncated overall, but this author's window agrees with the ground truth", func(t *testing.T) {
		var n ghPRNode
		n.Reviews.PageInfo.HasNextPage = true
		n.Reviews.Nodes = []reviewNode{
			rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
			rev("alice", "COMMENTED", "2026-01-01T09:05:00Z"),
		}
		// alice's last-seen review in our window (COMMENTED) matches her true
		// latest review — nothing of hers was truncated away, even though
		// the PR as a whole has more reviews (from other authors) than we
		// fetched.
		n.LatestReviews.Nodes = append(n.LatestReviews.Nodes, latest("alice", "COMMENTED"))

		got := stateOf(t, mergeReviewers(n), "alice")
		if got != "APPROVED" {
			t.Fatalf("got %q, want APPROVED (fold trusted despite overall truncation)", got)
		}
	})

	t.Run("truncated and this author's window disagrees: UNKNOWN, not a guess", func(t *testing.T) {
		var n ghPRNode
		n.Reviews.PageInfo.HasNextPage = true
		n.Reviews.Nodes = []reviewNode{
			// Our window only captured an old approval — a newer
			// CHANGES_REQUESTED fell outside the fetched (oldest-first)
			// page.
			rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
		}
		n.LatestReviews.Nodes = append(n.LatestReviews.Nodes, latest("alice", "CHANGES_REQUESTED"))

		got := stateOf(t, mergeReviewers(n), "alice")
		if got != stateUnknown {
			t.Fatalf("got %q, want %q (can't trust an incomplete fold)", got, stateUnknown)
		}
	})

	t.Run("truncated and this author has no reviews in our window at all: UNKNOWN", func(t *testing.T) {
		var n ghPRNode
		n.Reviews.PageInfo.HasNextPage = true
		n.Reviews.Nodes = []reviewNode{
			rev("bob", "COMMENTED", "2026-01-01T09:00:00Z"),
		}
		// alice reviewed (per the ground truth) but her reviews were entirely
		// pushed out of our capped window.
		n.LatestReviews.Nodes = append(n.LatestReviews.Nodes, latest("alice", "APPROVED"))

		got := stateOf(t, mergeReviewers(n), "alice")
		if got != stateUnknown {
			t.Fatalf("got %q, want %q", got, stateUnknown)
		}
	})

	t.Run("not truncated: the fold is trusted even if it somehow differs from latestReviews", func(t *testing.T) {
		// Defensive case — shouldn't happen against a real API response
		// (both fields come from the same query), but with complete data the
		// fold is strictly more informative than the raw latest-review
		// state, so it must win regardless.
		var n ghPRNode
		n.Reviews.PageInfo.HasNextPage = false
		n.Reviews.Nodes = []reviewNode{
			rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
			rev("alice", "COMMENTED", "2026-01-01T09:05:00Z"),
		}
		n.LatestReviews.Nodes = append(n.LatestReviews.Nodes, latest("alice", "COMMENTED"))

		got := stateOf(t, mergeReviewers(n), "alice")
		if got != "APPROVED" {
			t.Fatalf("got %q, want APPROVED", got)
		}
	})
}

// TestMergeReviewersReviewRequestOverridesFold proves the existing
// "a re-request wins over an old review" rule survived the rewrite
// unchanged: an open review request always overwrites to PENDING, even for
// an author who previously approved.
func TestMergeReviewersReviewRequestOverridesFold(t *testing.T) {
	var n ghPRNode
	n.Reviews.Nodes = []reviewNode{
		rev("alice", "APPROVED", "2026-01-01T09:00:00Z"),
	}
	n.LatestReviews.Nodes = append(n.LatestReviews.Nodes, latest("alice", "APPROVED"))
	n.ReviewRequests.Nodes = append(n.ReviewRequests.Nodes, struct {
		RequestedReviewer struct {
			Typename  string `json:"__typename"`
			Login     string `json:"login"`
			AvatarURL string `json:"avatarUrl"`
			Name      string `json:"name"`
		} `json:"requestedReviewer"`
	}{})
	n.ReviewRequests.Nodes[0].RequestedReviewer.Login = "alice"

	got := stateOf(t, mergeReviewers(n), "alice")
	if got != "PENDING" {
		t.Fatalf("got %q, want PENDING (re-request must win)", got)
	}
}

// TestMyLastActivity covers the "new since your comment/review" signal
// (myLastActivity + statusFromNode's NewSinceKind): it must only fire once the
// PR's own updatedAt postdates the reviewer's OWN last comment/review, must
// pick the LATER of the two categories, and must stay empty for a reviewer who
// never did either.
func TestMyLastActivity(t *testing.T) {
	const me = "reindert"

	t.Run("nothing happened after your review", func(t *testing.T) {
		var n ghPRNode
		n.UpdatedAt = "2026-01-01T09:00:00Z"
		n.Reviews.Nodes = []reviewNode{rev(me, "APPROVED", "2026-01-01T09:00:00Z")}
		st := statusFromNode(n, me, "")
		if st.NewSinceKind != "" {
			t.Fatalf("got NewSinceKind %q, want empty (updatedAt == your review time)", st.NewSinceKind)
		}
	})

	t.Run("something happened after your review", func(t *testing.T) {
		var n ghPRNode
		n.UpdatedAt = "2026-01-01T12:00:00Z"
		n.Reviews.Nodes = []reviewNode{rev(me, "CHANGES_REQUESTED", "2026-01-01T09:00:00Z")}
		st := statusFromNode(n, me, "")
		if st.NewSinceKind != "review" {
			t.Fatalf("got NewSinceKind %q, want \"review\"", st.NewSinceKind)
		}
	})

	t.Run("something happened after your comment", func(t *testing.T) {
		var n ghPRNode
		n.UpdatedAt = "2026-01-01T12:00:00Z"
		n.Comments.Nodes = append(n.Comments.Nodes, struct {
			Author struct {
				Login string `json:"login"`
			} `json:"author"`
			CreatedAt string `json:"createdAt"`
		}{CreatedAt: "2026-01-01T09:00:00Z"})
		n.Comments.Nodes[0].Author.Login = me
		st := statusFromNode(n, me, "")
		if st.NewSinceKind != "comment" {
			t.Fatalf("got NewSinceKind %q, want \"comment\"", st.NewSinceKind)
		}
	})

	t.Run("your later review wins over an earlier comment", func(t *testing.T) {
		var n ghPRNode
		n.UpdatedAt = "2026-01-01T12:00:00Z"
		n.Reviews.Nodes = []reviewNode{rev(me, "COMMENTED", "2026-01-01T10:00:00Z")}
		n.Comments.Nodes = append(n.Comments.Nodes, struct {
			Author struct {
				Login string `json:"login"`
			} `json:"author"`
			CreatedAt string `json:"createdAt"`
		}{CreatedAt: "2026-01-01T09:00:00Z"})
		n.Comments.Nodes[0].Author.Login = me
		st := statusFromNode(n, me, "")
		if st.NewSinceKind != "review" {
			t.Fatalf("got NewSinceKind %q, want \"review\" (later than the comment)", st.NewSinceKind)
		}
	})

	t.Run("you never commented or reviewed", func(t *testing.T) {
		var n ghPRNode
		n.UpdatedAt = "2026-01-01T12:00:00Z"
		n.Reviews.Nodes = []reviewNode{rev("someone-else", "APPROVED", "2026-01-01T09:00:00Z")}
		st := statusFromNode(n, me, "")
		if st.NewSinceKind != "" {
			t.Fatalf("got NewSinceKind %q, want empty (you never acted on this PR)", st.NewSinceKind)
		}
	})

	// Own-PR scenario (PPTD-948): GitHub never carries a review FROM the
	// author on their own PR, so myLastActivity's ghAt is empty — only the
	// in-app FullyApprovedAt tells the badge "you've already seen this".
	t.Run("own PR: never reviewed on GitHub, but fully approved in-app after the last update", func(t *testing.T) {
		var n ghPRNode
		n.UpdatedAt = "2026-01-01T09:00:00Z"
		st := statusFromNode(n, me, "2026-01-01T10:00:00Z")
		if st.NewSinceKind != "" {
			t.Fatalf("got NewSinceKind %q, want empty (fully approved AFTER the last update)", st.NewSinceKind)
		}
	})

	t.Run("own PR: fully approved, then a later commit reopens the badge", func(t *testing.T) {
		var n ghPRNode
		n.UpdatedAt = "2026-01-01T12:00:00Z" // a new commit landed after the full approval
		st := statusFromNode(n, me, "2026-01-01T10:00:00Z")
		if st.NewSinceKind != "review" || st.NewSinceAt != "2026-01-01T10:00:00Z" {
			t.Fatalf("got (%q, %q), want (\"review\", the fully-approved moment)", st.NewSinceKind, st.NewSinceAt)
		}
	})
}

// TestCombineSinceMoment covers the pure fold at the heart of the fix above:
// whichever of the GitHub-derived moment (ghAt/ghKind) and the in-app
// fully-approved moment is LATER wins; fullyApprovedAt winning always reports
// kind "review" (that's exactly what it represents).
func TestCombineSinceMoment(t *testing.T) {
	cases := []struct {
		name                       string
		ghAt, ghKind, fullyApprove string
		wantAt, wantKind           string
	}{
		{
			name: "no local approval moment at all: GitHub wins as-is",
			ghAt: "2026-01-01T09:00:00Z", ghKind: "comment",
			wantAt: "2026-01-01T09:00:00Z", wantKind: "comment",
		},
		{
			name:         "no GitHub activity at all: the local moment wins",
			fullyApprove: "2026-01-01T09:00:00Z",
			wantAt:       "2026-01-01T09:00:00Z", wantKind: "review",
		},
		{
			name: "GitHub activity is later: it wins",
			ghAt: "2026-01-01T12:00:00Z", ghKind: "review",
			fullyApprove: "2026-01-01T09:00:00Z",
			wantAt:       "2026-01-01T12:00:00Z", wantKind: "review",
		},
		{
			name: "the local full-approval moment is later: it wins, as a review",
			ghAt: "2026-01-01T09:00:00Z", ghKind: "comment",
			fullyApprove: "2026-01-01T12:00:00Z",
			wantAt:       "2026-01-01T12:00:00Z", wantKind: "review",
		},
		{
			name:   "neither ever happened",
			wantAt: "", wantKind: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			at, kind := combineSinceMoment(tc.ghAt, tc.ghKind, tc.fullyApprove)
			if at != tc.wantAt || kind != tc.wantKind {
				t.Fatalf("got (%q, %q), want (%q, %q)", at, kind, tc.wantAt, tc.wantKind)
			}
		})
	}
}
