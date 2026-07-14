package prmeta

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func open(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "prmeta.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

// TestSaveBasicsRoundTrip asserts stage 1 (basics + Jira fields) round-trips.
func TestSaveBasicsRoundTrip(t *testing.T) {
	m := open(t)
	ctx := context.Background()
	in := Meta{
		PR: 7, Title: "PS-123 fix the thing", URL: "https://github.com/x/y/pull/7",
		Body: "does a thing", Author: "alice", Additions: 10, Deletions: 2, ChangedFiles: 3,
		HeadRef: "feature/x",
		JiraKey: "PS-123", JiraTitle: "Fix the thing", JiraDesc: "desc", JiraURL: "https://x/browse/PS-123",
	}
	if err := m.SaveBasics(ctx, in); err != nil {
		t.Fatal(err)
	}
	got, ok, err := m.Get(ctx, 7)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if got.Title != in.Title || got.Body != in.Body || got.Author != in.Author ||
		got.Additions != in.Additions || got.Deletions != in.Deletions || got.ChangedFiles != in.ChangedFiles ||
		got.HeadRef != in.HeadRef || got.JiraKey != in.JiraKey || got.JiraTitle != in.JiraTitle ||
		got.JiraDesc != in.JiraDesc || got.JiraURL != in.JiraURL {
		t.Fatalf("got %+v, want basics of %+v", got, in)
	}
	if got.Summary != "" || got.ReviewDecision != "" || got.ChecksTotal != 0 {
		t.Fatalf("later stages should still be zero: %+v", got)
	}
}

// TestSaveSummaryDoesNotClobberBasics asserts stage 2 only touches summary,
// leaving the stage-1 fields intact.
func TestSaveSummaryDoesNotClobberBasics(t *testing.T) {
	m := open(t)
	ctx := context.Background()
	if err := m.SaveBasics(ctx, Meta{PR: 1, Title: "T", Body: "B", Author: "a"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveSummary(ctx, 1, "a short summary"); err != nil {
		t.Fatal(err)
	}
	got, ok, err := m.Get(ctx, 1)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if got.Title != "T" || got.Body != "B" || got.Author != "a" {
		t.Fatalf("basics clobbered: %+v", got)
	}
	if got.Summary != "a short summary" {
		t.Fatalf("summary = %q", got.Summary)
	}
}

// TestSaveStatusesDoesNotClobberSummary asserts stage 3 only touches the status
// columns, leaving basics + summary intact.
func TestSaveStatusesDoesNotClobberSummary(t *testing.T) {
	m := open(t)
	ctx := context.Background()
	if err := m.SaveBasics(ctx, Meta{PR: 2, Title: "T2"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveSummary(ctx, 2, "sum"); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveStatuses(ctx, 2, "APPROVED", 5, 4, []string{"bob", "carol"}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := m.Get(ctx, 2)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if got.Title != "T2" || got.Summary != "sum" {
		t.Fatalf("earlier stages clobbered: %+v", got)
	}
	if got.ReviewDecision != "APPROVED" || got.ChecksTotal != 5 || got.ChecksPassed != 4 {
		t.Fatalf("statuses = %+v", got)
	}
	if !reflect.DeepEqual(got.Reviewers, []string{"bob", "carol"}) {
		t.Fatalf("reviewers = %v", got.Reviewers)
	}
}

// TestGetMissing asserts an unfetched PR reports ok=false.
func TestGetMissing(t *testing.T) {
	m := open(t)
	_, ok, err := m.Get(context.Background(), 999)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("want ok=false for a PR never stored")
	}
}
