package main

import (
	"reflect"
	"sort"
	"testing"

	"slash/modules/autoingestpref"
)

// helper to build one inbox row with just the fields eligibleAutoIngestPRs
// cares about.
func aiRow(number int, author string, hasGraph bool) inboxRow {
	return inboxRow{Number: number, Author: author, HasGraph: hasGraph}
}

func aiSections() []inboxSection {
	return []inboxSection{
		{Title: "Ready to merge", PRs: []inboxRow{aiRow(1, "me", false)}},
		{Title: "Needs action", PRs: []inboxRow{aiRow(2, "me", false), aiRow(3, "other", false)}},
		{Title: "Waiting for review or checks", PRs: []inboxRow{aiRow(4, "me", false), aiRow(5, "me", true)}},
		{Title: "Your drafts", PRs: []inboxRow{aiRow(6, "me", false)}},
		{Title: "Needs your team's review", PRs: []inboxRow{aiRow(7, "other", false)}},
		{Title: "Needs your review", PRs: []inboxRow{aiRow(8, "other", false)}},
	}
}

func sortedNumbers(keys []prKey) []int {
	out := make([]int, len(keys))
	for i, k := range keys {
		out[i] = k.PR
	}
	sort.Ints(out)
	return out
}

func TestEligibleAutoIngestPRsModeOff(t *testing.T) {
	got := eligibleAutoIngestPRs(autoingestpref.ModeOff, "me", aiSections())
	if len(got) != 0 {
		t.Fatalf("ModeOff: got %v, want none", got)
	}
}

func TestEligibleAutoIngestPRsModeOwn(t *testing.T) {
	// Own mode only covers "Needs action", "Waiting for review or checks" and
	// "Your drafts" (confirmed section list) — never "Ready to merge" (#1,
	// excluded on purpose) and never a PR authored by someone else (#3) or one
	// that already has a graph (#5).
	got := eligibleAutoIngestPRs(autoingestpref.ModeOwn, "me", aiSections())
	want := []int{2, 4, 6}
	if !reflect.DeepEqual(sortedNumbers(got), want) {
		t.Fatalf("ModeOwn: got PRs %v, want %v", sortedNumbers(got), want)
	}
}

func TestEligibleAutoIngestPRsModeOwnEmptyLogin(t *testing.T) {
	// An unresolved "who am I" must never fall back to matching every author.
	got := eligibleAutoIngestPRs(autoingestpref.ModeOwn, "", aiSections())
	if len(got) != 0 {
		t.Fatalf("ModeOwn with empty myLogin: got %v, want none", got)
	}
}

func TestEligibleAutoIngestPRsModeAll(t *testing.T) {
	// All mode covers every section, any author, still excluding an already
	// generated PR (#5).
	got := eligibleAutoIngestPRs(autoingestpref.ModeAll, "me", aiSections())
	want := []int{1, 2, 3, 4, 6, 7, 8}
	if !reflect.DeepEqual(sortedNumbers(got), want) {
		t.Fatalf("ModeAll: got PRs %v, want %v", sortedNumbers(got), want)
	}
}
