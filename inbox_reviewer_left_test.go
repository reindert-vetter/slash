package main

import (
	"context"
	"path/filepath"
	"testing"

	"slash/modules/prmeta"
)

// commentedCatch returns the "Needs your review" reviewed-by:@me query — the
// COMMENTED catch whose keep filter honours the reviewer-left marks.
func commentedCatch(t *testing.T) queryDef {
	t.Helper()
	for _, s := range inboxSections {
		if s.title != "Needs your review" {
			continue
		}
		for _, q := range s.queries {
			if q.keep != nil {
				return q
			}
		}
	}
	t.Fatal("no COMMENTED catch in Needs your review")
	return queryDef{}
}

// TestCommentedCatchSkipsPRsIleft proves a PR I took myself off ("Verwijder mij
// als reviewer") no longer comes back through the COMMENTED catch, while an
// unmarked COMMENTED PR still does.
func TestCommentedCatchSkipsPRsIleft(t *testing.T) {
	keep := commentedCatch(t).keep
	row := func(repo string, n int) inboxRow {
		return inboxRow{Repo: repo, Number: n, Reviewers: []reviewer{{Login: "me", State: "COMMENTED"}}}
	}
	kc := keepCtx{login: "me", left: map[prKey]bool{{"", 1}: true, {"ops/x", 2}: true}}

	if keep(row("", 1), kc) {
		t.Error("marked PR must be skipped")
	}
	if keep(row("ops/x", 2), kc) {
		t.Error("marked PR in another repo must be skipped")
	}
	if !keep(row("", 2), kc) {
		t.Error("same number in the primary repo is not marked and must be kept")
	}
	if !keep(row("", 3), keepCtx{login: "me"}) {
		t.Error("without marks a COMMENTED PR is kept, as before")
	}
}

// TestReRequestedMarks proves only a marked PR where I am a requested reviewer
// again (PENDING) is selected for clearing — not one where I only commented.
func TestReRequestedMarks(t *testing.T) {
	sections := []inboxSection{
		{Title: "Needs your review", PRs: []inboxRow{{Number: 1}, {Number: 2}, {Number: 4}}},
		{Title: "Other", PRs: []inboxRow{{Number: 3}}},
	}
	statuses := map[string]prStatus{
		"1": {Reviewers: []reviewer{{Login: "me", State: "PENDING"}}},   // re-requested
		"2": {Reviewers: []reviewer{{Login: "me", State: "COMMENTED"}}}, // only commented
		"3": {Reviewers: []reviewer{{Login: "me", State: "PENDING", Team: true}}},
		"4": {Reviewers: []reviewer{{Login: "me", State: "PENDING"}}}, // not marked
	}
	left := map[prKey]bool{{"", 1}: true, {"", 2}: true, {"", 3}: true}

	got := reRequestedMarks(sections, statuses, "me", left)
	if len(got) != 1 || got[0] != (prKey{"", 1}) {
		t.Fatalf("reRequestedMarks = %v, want only PR 1", got)
	}
}

// TestReviewerLeftMarkRoundTrip covers the prmeta mark: save, list via
// reviewerLeftSet, clear.
func TestReviewerLeftMarkRoundTrip(t *testing.T) {
	ctx := context.Background()
	pm, err := prmeta.Open(filepath.Join(t.TempDir(), "prmeta.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer pm.Close()

	if err := pm.SaveReviewerLeftAt(ctx, "", 7, "2026-10-07T09:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if set := reviewerLeftSet(ctx, pm); !set[prKey{"", 7}] || len(set) != 1 {
		t.Fatalf("reviewerLeftSet = %v, want {7}", set)
	}
	if err := pm.ClearReviewerLeftAt(ctx, "", 7); err != nil {
		t.Fatal(err)
	}
	if set := reviewerLeftSet(ctx, pm); len(set) != 0 {
		t.Fatalf("after clear: %v, want empty", set)
	}
	if reviewerLeftSet(ctx, nil) != nil {
		t.Fatal("nil prmeta must yield nil")
	}
}
