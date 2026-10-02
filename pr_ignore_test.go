package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/autoingestpref"
	"slash/modules/github"
	"slash/modules/prignore"
)

// pr_ignore end-to-end against a real (temp) prignore store: an ignore Signal
// lands a row, ignore=false removes it, EnsurePrIgnore reuses its run.
func TestPrIgnoreWorkflow(t *testing.T) {
	pi, err := prignore.Open(filepath.Join(t.TempDir(), "prignore.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pi.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.prignore = pi
	ctx := context.Background()

	runID, err := m.EnsurePrIgnore()
	if err != nil || runID == "" {
		t.Fatalf("EnsurePrIgnore = %q, %v", runID, err)
	}
	if again, _ := m.EnsurePrIgnore(); again != runID {
		t.Fatalf("second run started: %q vs %q", again, runID)
	}
	if err := engine.SignalWorkflow(runID, SignalPrIgnore, PrIgnoreSignal{PR: 42, Ignore: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := m.PrIgnores(ctx)
		return len(got) == 1 && got[0].PR == 42
	})
	if err := engine.SignalWorkflow(runID, SignalPrIgnore, PrIgnoreSignal{PR: 42, Ignore: false}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := m.PrIgnores(ctx)
		return len(got) == 0
	})
}

// A purge that hangs (here: ingestMu held) must not block the tracker: the
// ignore row is saved and the next Signal is still handled.
func TestPrIgnoreNotBlockedByHangingPurge(t *testing.T) {
	pi, err := prignore.Open(filepath.Join(t.TempDir(), "prignore.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pi.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.prignore = pi
	runID, err := m.EnsurePrIgnore()
	if err != nil {
		t.Fatal(err)
	}
	ingestMu.Lock() // every purge now waits here
	t.Cleanup(func() { time.Sleep(50 * time.Millisecond) })
	defer ingestMu.Unlock()
	for _, pr := range []int{41, 42} {
		if err := engine.SignalWorkflow(runID, SignalPrIgnore, PrIgnoreSignal{PR: pr, Ignore: true}); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, func() bool {
		got, _ := m.PrIgnores(context.Background())
		return len(got) == 2
	})
}

// An ignore only hides a PR in Migrations & API changes: once the PR sits in
// "Needs your review" (reviewer added later) it is still eligible there.
func TestIgnoredPRStillEligibleInNeedsReview(t *testing.T) {
	ignored := map[prKey]bool{{"", 7}: true}
	secs := []inboxSection{
		{Title: needsYourReviewTitle, PRs: []inboxRow{{Number: 7}}},
		{Title: touchedSectionTitle, PRs: []inboxRow{{Number: 8}}},
	}
	ignored[prKey{"", 8}] = true
	got := eligibleAutoIngestPRs(autoingestpref.ModeAll, "me", secs, ignored)
	if len(got) != 1 || got[0].PR != 7 {
		t.Fatalf("got %+v, want only PR 7", got)
	}
}
