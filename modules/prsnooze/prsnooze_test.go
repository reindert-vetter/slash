package prsnooze

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestPrSnoozeSetListClear(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "prsnooze.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()
	at := time.Date(2026, 9, 30, 14, 0, 0, 0, time.UTC)

	if err := m.Set(ctx, "", 12112, at.Add(18*time.Hour), at); err != nil {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "acme/ops", 7, at.Add(time.Hour), at); err != nil {
		t.Fatal(err)
	}
	got, err := m.List(ctx, at)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Repo != "acme/ops" || got[1].PR != 12112 || !got[1].SnoozedAt.Equal(at) {
		t.Fatalf("List = %+v, want both snoozes ordered by wake-up time", got)
	}

	// An expired snooze is not listed anymore.
	if got, _ := m.List(ctx, at.Add(2*time.Hour)); len(got) != 1 || got[0].PR != 12112 {
		t.Fatalf("List after the first wake-up = %+v, want only 12112", got)
	}

	// Snoozing again overwrites; Clear removes; clearing twice is a no-op.
	if err := m.Set(ctx, "", 12112, at.Add(48*time.Hour), at.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got, _ := m.List(ctx, at.Add(30*time.Hour)); len(got) != 1 || !got[0].Until.Equal(at.Add(48*time.Hour)) {
		t.Fatalf("List after re-snooze = %+v", got)
	}
	for i := 0; i < 2; i++ {
		if err := m.Clear(ctx, "", 12112); err != nil {
			t.Fatal(err)
		}
	}
	if got, _ := m.List(ctx, at); len(got) != 1 || got[0].Repo != "acme/ops" {
		t.Fatalf("List after Clear = %+v, want only acme/ops#7", got)
	}
}
