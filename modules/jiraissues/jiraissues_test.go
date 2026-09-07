package jiraissues

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func openTest(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "jiraissues.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

// Nothing stored yet (a fresh install, or the first refresh still in flight)
// is not an error — the endpoint then simply serves an empty section.
func TestGetWithoutASnapshotIsNotAnError(t *testing.T) {
	got, err := openTest(t).Get(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

// A Save replaces the single row rather than adding one, so the page always
// reads exactly the most recent refresh.
func TestSaveReplacesTheSingleSnapshot(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	if err := m.Save(ctx, Snapshot{Issues: json.RawMessage(`[{"key":"PROD-1"}]`)}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := m.Save(ctx, Snapshot{
		UpdatedAt: "2026-09-06T10:00:00Z",
		Issues:    json.RawMessage(`[{"key":"PROD-2"},{"key":"PROD-9"}]`),
		Error:     "acli not logged in",
	}); err != nil {
		t.Fatalf("save again: %v", err)
	}
	got, err := m.Get(ctx)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil {
		t.Fatal("got nil, want the stored snapshot")
	}
	if string(got.Issues) != `[{"key":"PROD-2"},{"key":"PROD-9"}]` {
		t.Fatalf("issues = %s, want the second save", got.Issues)
	}
	if got.UpdatedAt != "2026-09-06T10:00:00Z" || got.Error != "acli not logged in" {
		t.Fatalf("got %+v, want the second save's stamp and reason", got)
	}
}

// An empty list round-trips as an empty JSON array, never as invalid JSON the
// handler would have to special-case.
func TestSaveDefaultsAnEmptyListToAJSONArray(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	if err := m.Save(ctx, Snapshot{}); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := m.Get(ctx)
	if err != nil || got == nil {
		t.Fatalf("get: %v / %+v", err, got)
	}
	if string(got.Issues) != "[]" {
		t.Fatalf("issues = %s, want an empty array", got.Issues)
	}
	if got.UpdatedAt == "" {
		t.Fatal("updatedAt is empty, want a stamp filled in by Save")
	}
}
