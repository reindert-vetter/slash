package autoingestpref

import (
	"context"
	"path/filepath"
	"testing"
)

func TestAutoIngestPrefDefaultsToOwn(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "autoingestpref.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	mode, err := m.Mode(context.Background(), "test/repo")
	if err != nil {
		t.Fatal(err)
	}
	if mode != ModeOwn {
		t.Fatalf("Mode() = %q, want %q (default) for a repo that never saved a preference", mode, ModeOwn)
	}
}

func TestAutoIngestPrefSetModePersists(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "autoingestpref.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if err := m.SetMode(ctx, "test/repo", ModeOff); err != nil {
		t.Fatal(err)
	}
	if mode, _ := m.Mode(ctx, "test/repo"); mode != ModeOff {
		t.Fatalf("Mode() = %q after SetMode(off), want %q", mode, ModeOff)
	}

	if err := m.SetMode(ctx, "test/repo", ModeAll); err != nil {
		t.Fatal(err)
	}
	if mode, _ := m.Mode(ctx, "test/repo"); mode != ModeAll {
		t.Fatalf("Mode() = %q after SetMode(all), want %q", mode, ModeAll)
	}

	// A different repo is unaffected.
	if mode, _ := m.Mode(ctx, "other/repo"); mode != ModeOwn {
		t.Fatalf("Mode() for an unrelated repo = %q, want default %q", mode, ModeOwn)
	}
}
