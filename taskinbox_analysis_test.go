package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"slash/modules/comments"
	"slash/modules/jira"
)

// TestComputeTaskPoints is a table test on the pure scoring function: every
// base score + every point rule, in isolation and stacked.
func TestComputeTaskPoints(t *testing.T) {
	cases := []struct {
		name  string
		sig   taskSignals
		want  int
		notes int // expected len(notes), incl. the "basis" note
	}{
		{"pr_review base only", taskSignals{Kind: kindPRReview}, 20, 1},
		{"pr_review ci failing", taskSignals{Kind: kindPRReview, ChecksFailing: true}, 30, 2},
		{"pr_review aging (>3 days)", taskSignals{Kind: kindPRReview, AgeDays: 4}, 30, 2},
		{"pr_review aging boundary (3 days, not yet)", taskSignals{Kind: kindPRReview, AgeDays: 3}, 20, 1},
		{"pr_review both", taskSignals{Kind: kindPRReview, ChecksFailing: true, AgeDays: 10}, 40, 3},

		{"comment_unread base only", taskSignals{Kind: kindCommentUnread}, 20, 1},
		{"comment_unread changes requested", taskSignals{Kind: kindCommentUnread, ChangesRequested: true}, 30, 2},
		{"comment_unread aging day 0 (just unread)", taskSignals{Kind: kindCommentUnread, UnansweredDays: 0}, 20, 1},
		{"comment_unread aging day 1", taskSignals{Kind: kindCommentUnread, UnansweredDays: 1}, 30, 2},
		{"comment_unread aging day 2", taskSignals{Kind: kindCommentUnread, UnansweredDays: 2}, 40, 2},
		{"comment_unread aging day 3 (cap)", taskSignals{Kind: kindCommentUnread, UnansweredDays: 3}, 50, 2},
		{"comment_unread aging day 10 (still capped at +30)", taskSignals{Kind: kindCommentUnread, UnansweredDays: 10}, 50, 2},
		{"comment_unread both", taskSignals{Kind: kindCommentUnread, ChangesRequested: true, UnansweredDays: 2}, 50, 3},

		{"jira base only", taskSignals{Kind: kindJira}, 10, 1},
		{"jira active", taskSignals{Kind: kindJira, JiraActive: true}, 20, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			points, notes := computeTaskPoints(c.sig)
			if points != c.want {
				t.Fatalf("points = %d, want %d (notes=%+v)", points, c.want, notes)
			}
			if len(notes) != c.notes {
				t.Fatalf("len(notes) = %d, want %d (%+v)", len(notes), c.notes, notes)
			}
			if notes[0].Label != "basis" {
				t.Fatalf("notes[0] = %+v, want the base note first", notes[0])
			}
		})
	}
}

// TestIsJiraActive covers the Backlog/To Do carve-out (case-insensitive) and
// the "unknown status" default (never active).
func TestIsJiraActive(t *testing.T) {
	cases := map[string]bool{
		"":            false,
		"Backlog":     false,
		"to do":       false,
		"To Do":       false,
		"In Review":   true,
		"In Progress": true,
		"Done":        true,
	}
	for status, want := range cases {
		if got := isJiraActive(status); got != want {
			t.Errorf("isJiraActive(%q) = %v, want %v", status, got, want)
		}
	}
}

// openTestComments opens a throwaway comments module for a test.
func openTestComments(t *testing.T) *comments.Module {
	t.Helper()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// TestUnreadCommentCandidates covers the core unread-detection logic: a root
// comment with no reply is unread as long as its OWN author isn't the PR
// author (i.e. someone else left the last word); a reply flips who "last
// spoke"; a resolved thread never counts, however it ends.
func TestUnreadCommentCandidates(t *testing.T) {
	cs := openTestComments(t)
	ctx := context.Background()
	const login = "reindert-vetter"
	const pr = 55

	now := time.Now()
	old := func(daysAgo int) string {
		return now.Add(-time.Duration(daysAgo) * 24 * time.Hour).Format(time.RFC3339Nano)
	}

	// c1: root comment from a colleague, no reply — last speaker is the
	// colleague (not me) → unread. ~2 days old → comment_aging kicks in.
	must(t, cs.Save(ctx, comments.Comment{ID: "c1", RunID: "c1", PR: pr, File: "a.php", Line: 1, Author: "colleague", Body: "please look at this", CreatedAt: old(2)}))

	// c2: root comment from ME (the PR author commenting on my own code) with
	// no reply — the last speaker IS me → not unread (nothing to read).
	must(t, cs.Save(ctx, comments.Comment{ID: "c2", RunID: "c2", PR: pr, File: "a.php", Line: 2, Author: login, Body: "note to self", CreatedAt: old(1)}))

	// c3: root comment from a colleague; I replied, then the colleague
	// replied again — the LAST message is again the colleague's → unread,
	// regardless of the root author or my own reply in between.
	must(t, cs.Save(ctx, comments.Comment{ID: "c3", RunID: "c3", PR: pr, File: "a.php", Line: 3, Author: "colleague", Body: "ping", CreatedAt: old(5)}))
	must(t, cs.AddReaction(ctx, comments.Reaction{ID: "c3-r1", CommentID: "c3", Author: login, Body: "looking", CreatedAt: old(4)}))
	must(t, cs.AddReaction(ctx, comments.Reaction{ID: "c3-r2", CommentID: "c3", Author: "colleague", Body: "still waiting", CreatedAt: old(3)}))

	// c4: same shape as c1 (colleague left the last word) but resolved — must
	// never surface, however unread it would otherwise look.
	must(t, cs.Save(ctx, comments.Comment{ID: "c4", RunID: "c4", PR: pr, File: "a.php", Line: 4, Author: "colleague", Body: "resolved thread", CreatedAt: old(2)}))
	must(t, cs.AddReaction(ctx, comments.Reaction{ID: "c4-r1", CommentID: "c4", Author: login, Body: "done", CreatedAt: old(1), Resolves: true}))

	snap := &snapshotResult{
		GeneratedFor: login,
		Sections: []inboxSection{
			{Title: "Ready to merge", PRs: []inboxRow{{Number: pr, Title: "My PR", Author: login, URL: "https://x/pull/55"}}},
		},
		Statuses: map[string]prStatus{
			"55": {ReviewDecision: "CHANGES_REQUESTED"},
		},
	}

	got, err := unreadCommentCandidates(ctx, cs, snap, login)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 unread candidates (c1, c3), got %d: %+v", len(got), got)
	}
	byID := map[string]taskCandidate{}
	for _, c := range got {
		byID[c.id] = c
	}
	c1, ok := byID["comment:c1"]
	if !ok {
		t.Fatalf("missing comment:c1 in %+v", got)
	}
	if !c1.signals.ChangesRequested {
		t.Fatalf("c1 should carry ChangesRequested=true from the PR's reviewDecision")
	}
	if c1.signals.UnansweredDays < 1 {
		t.Fatalf("c1 UnansweredDays = %d, want >= 1 (created 2 days ago)", c1.signals.UnansweredDays)
	}
	if _, ok := byID["comment:c3"]; !ok {
		t.Fatalf("missing comment:c3 (last speaker is the colleague after a reply exchange) in %+v", got)
	}
	if _, ok := byID["comment:c2"]; ok {
		t.Fatalf("comment:c2 (I spoke last) must not be unread")
	}
	if _, ok := byID["comment:c4"]; ok {
		t.Fatalf("comment:c4 (resolved) must not be unread")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// TestJiraCandidates covers the Jira task source mapping, via jira.Fake (no
// acli/network involved).
func TestJiraCandidates(t *testing.T) {
	jr := &jira.Fake{}
	jr.SetAssigned([]jira.Issue{
		{Key: "INTEG-1", Title: "Backlog ticket", Status: "To Do", URL: "https://x/INTEG-1"},
		{Key: "INTEG-2", Title: "Active ticket", Status: "In Progress", Description: "desc", URL: "https://x/INTEG-2"},
	})

	got, err := jiraCandidates(context.Background(), jr)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 candidates, got %d", len(got))
	}
	byID := map[string]taskCandidate{}
	for _, c := range got {
		byID[c.id] = c
	}
	backlog, ok := byID["jira:INTEG-1"]
	if !ok {
		t.Fatalf("missing jira:INTEG-1")
	}
	if backlog.signals.JiraActive {
		t.Fatalf("Backlog/To Do ticket must not be JiraActive")
	}
	if p, _ := computeTaskPoints(backlog.signals); p != 10 {
		t.Fatalf("backlog points = %d, want 10 (base only)", p)
	}

	active, ok := byID["jira:INTEG-2"]
	if !ok {
		t.Fatalf("missing jira:INTEG-2")
	}
	if !active.signals.JiraActive {
		t.Fatalf("In Progress ticket must be JiraActive")
	}
	if p, _ := computeTaskPoints(active.signals); p != 20 {
		t.Fatalf("active points = %d, want 20 (base + jira_active)", p)
	}
	if active.kind != kindJira || active.url != "https://x/INTEG-2" {
		t.Fatalf("candidate mapping wrong: %+v", active)
	}
}
