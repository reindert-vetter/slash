package main

import "testing"

// TestSortSearchRowsRanking pins the four search ranks the reviewer asked for
// ("ik wil hier ook kunnen zoeken op closed prs en prs van andere (wel in een
// lagere volgorde)"): own open, other open, own closed, other closed — and
// proves the sort is STABLE, so gh's sort:updated-desc ordering survives inside
// each rank. Pure function, no gh and no fixture.
func TestSortSearchRowsRanking(t *testing.T) {
	rows := []inboxRow{
		{Number: 1, Author: "other", State: "CLOSED"},
		{Number: 2, Author: "me", State: "MERGED"},
		{Number: 3, Author: "other", State: "OPEN"},
		{Number: 4, Author: "me", State: "OPEN"},
	}
	sortSearchRows(rows, "me")
	want := []int{4, 3, 2, 1}
	for i, n := range want {
		if rows[i].Number != n {
			t.Fatalf("rank order = %v, want %v", numbers(rows), want)
		}
	}
}

// A row with no state at all (every inbox fixture row, and any stored snapshot
// predating the state field) must rank as OPEN, never as closed.
func TestSortSearchRowsTreatsMissingStateAsOpen(t *testing.T) {
	rows := []inboxRow{
		{Number: 1, Author: "me", State: "CLOSED"},
		{Number: 2, Author: "other"},
		{Number: 3, Author: "me"},
	}
	sortSearchRows(rows, "me")
	want := []int{3, 2, 1}
	for i, n := range want {
		if rows[i].Number != n {
			t.Fatalf("order = %v, want %v", numbers(rows), want)
		}
	}
}

// Within one rank the input order is preserved (stable sort), and an unknown
// login collapses the own/other halves without disturbing open-before-closed.
func TestSortSearchRowsStableAndLoginless(t *testing.T) {
	rows := []inboxRow{
		{Number: 10, Author: "a", State: "CLOSED"},
		{Number: 11, Author: "b", State: "OPEN"},
		{Number: 12, Author: "a", State: "OPEN"},
		{Number: 13, Author: "b", State: "MERGED"},
	}
	sortSearchRows(rows, "")
	want := []int{11, 12, 10, 13}
	for i, n := range want {
		if rows[i].Number != n {
			t.Fatalf("order = %v, want %v (stable, no login)", numbers(rows), want)
		}
	}
}

func numbers(rows []inboxRow) []int {
	out := make([]int, len(rows))
	for i, r := range rows {
		out[i] = r.Number
	}
	return out
}
