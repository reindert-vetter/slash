package prignore

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestSetClearList(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "i.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()
	at := time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)
	for i := 0; i < 2; i++ { // idempotent
		if err := m.Set(ctx, "", 7, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Set(ctx, "o/r", 7, at); err != nil {
		t.Fatal(err)
	}
	l, _ := m.List(ctx)
	if len(l) != 2 {
		t.Fatalf("want 2, got %d", len(l))
	}
	if err := m.Clear(ctx, "", 7); err != nil {
		t.Fatal(err)
	}
	l, _ = m.List(ctx)
	if len(l) != 1 || l[0].Repo != "o/r" {
		t.Fatalf("unexpected %+v", l)
	}
}
