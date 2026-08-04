package autowarn

import (
	"context"
	"path/filepath"
	"testing"
)

func TestAutoWarnDefaultsToEnabled(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "autowarn.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	enabled, err := m.Enabled(context.Background(), "test/repo")
	if err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Fatal("Enabled() = false, want true (default) for a repo that never saved a preference")
	}
}

func TestAutoWarnSetEnabledPersists(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "autowarn.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if err := m.SetEnabled(ctx, "test/repo", false); err != nil {
		t.Fatal(err)
	}
	if enabled, _ := m.Enabled(ctx, "test/repo"); enabled {
		t.Fatal("Enabled() = true after SetEnabled(false)")
	}

	if err := m.SetEnabled(ctx, "test/repo", true); err != nil {
		t.Fatal(err)
	}
	if enabled, _ := m.Enabled(ctx, "test/repo"); !enabled {
		t.Fatal("Enabled() = false after SetEnabled(true)")
	}

	// A different repo is unaffected.
	if enabled, _ := m.Enabled(ctx, "other/repo"); !enabled {
		t.Fatal("Enabled() for an unrelated repo should still default to true")
	}
}
