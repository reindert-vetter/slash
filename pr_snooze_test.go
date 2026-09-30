package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/prsnooze"
)

// snoozeUntil's three options, including the weekday edges of "next Monday"
// and a DST switch (Europe/Amsterdam goes to winter time on 2026-10-25).
func TestSnoozeUntil(t *testing.T) {
	ams, err := time.LoadLocation("Europe/Amsterdam")
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	at := func(y int, m time.Month, d, h int) time.Time { return time.Date(y, m, d, h, 0, 0, 0, ams) }
	cases := []struct {
		name   string
		now    time.Time
		option string
		want   time.Time
	}{
		{"tomorrow from a Wednesday afternoon", at(2026, 9, 30, 15), SnoozeTomorrow, at(2026, 10, 1, 8)},
		{"tomorrow just after midnight is still the next day", at(2026, 9, 30, 0), SnoozeTomorrow, at(2026, 10, 1, 8)},
		{"tomorrow across a month end", at(2026, 10, 31, 22), SnoozeTomorrow, at(2026, 11, 1, 8)},
		{"next Monday from a Wednesday", at(2026, 9, 30, 15), SnoozeNextMonday, at(2026, 10, 5, 8)},
		{"next Monday from a Monday is a week later", at(2026, 10, 5, 7), SnoozeNextMonday, at(2026, 10, 12, 8)},
		{"next Monday from a Sunday is tomorrow", at(2026, 10, 4, 20), SnoozeNextMonday, at(2026, 10, 5, 8)},
		{"7 days at 08:00", at(2026, 9, 30, 15), SnoozeSevenDays, at(2026, 10, 7, 8)},
		{"7 days across the DST switch stays 08:00 wall-clock", at(2026, 10, 22, 12), SnoozeSevenDays, at(2026, 10, 29, 8)},
	}
	for _, c := range cases {
		got, ok := snoozeUntil(c.now, c.option)
		if !ok || !got.Equal(c.want) || got.Hour() != 8 {
			t.Errorf("%s: snoozeUntil(%v, %q) = %v, %v; want %v", c.name, c.now, c.option, got, ok, c.want)
		}
	}
	if _, ok := snoozeUntil(at(2026, 9, 30, 15), SnoozeClear); ok {
		t.Error("clear must not produce a wake-up moment")
	}
	if _, ok := snoozeUntil(at(2026, 9, 30, 15), "forever"); ok {
		t.Error("an unknown option must be rejected")
	}
}

// The pr_snooze workflow end-to-end against a real (temp) prsnooze store: a
// snooze Signal lands a row whose wake-up moment the workflow computed itself,
// a clear Signal removes it again, and EnsurePrSnooze reuses its run.
func TestPrSnoozeWorkflow(t *testing.T) {
	ps, err := prsnooze.Open(filepath.Join(t.TempDir(), "prsnooze.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ps.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.prsnooze = ps
	ctx := context.Background()

	runID, err := m.EnsurePrSnooze()
	if err != nil || runID == "" {
		t.Fatalf("EnsurePrSnooze = %q, %v", runID, err)
	}
	if again, _ := m.EnsurePrSnooze(); again != runID {
		t.Fatalf("EnsurePrSnooze started a second run: %q vs %q", again, runID)
	}

	before := time.Now()
	if err := engine.SignalWorkflow(runID, SignalPrSnooze, PrSnoozeSignal{PR: 12112, Option: SnoozeTomorrow}); err != nil {
		t.Fatal(err)
	}
	var got []prsnooze.Snooze
	waitFor(t, func() bool {
		got, _ = m.PrSnoozes(ctx)
		return len(got) == 1
	})
	want, _ := snoozeUntil(got[0].SnoozedAt.In(time.Local), SnoozeTomorrow)
	if got[0].PR != 12112 || got[0].Repo != "" || !got[0].Until.Equal(want) {
		t.Fatalf("snooze = %+v, want PR 12112 until %v", got[0], want)
	}
	if got[0].SnoozedAt.Before(before.Truncate(time.Second)) {
		t.Fatalf("snoozedAt %v predates the Signal (%v)", got[0].SnoozedAt, before)
	}

	if err := engine.SignalWorkflow(runID, SignalPrSnooze, PrSnoozeSignal{PR: 12112, Option: SnoozeClear}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ = m.PrSnoozes(ctx)
		return len(got) == 0
	})
}
