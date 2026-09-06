package plan

import (
	"context"
	"path/filepath"
	"testing"
)

// TestSaveGetRoundTrip — the store is a plain per-key document: saving twice
// overwrites (idempotent replay), and an unknown key is "not there", never an
// error.
func TestSaveGetRoundTrip(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "plan.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer m.Close()
	ctx := context.Background()

	if _, ok, err := m.Get(ctx, "PAYM-1"); err != nil || ok {
		t.Fatalf("Get on an empty store = (%v, %v), want (false, nil)", ok, err)
	}
	if err := m.Save(ctx, "PAYM-1", `{"key":"PAYM-1"}`, "2026-09-06T10:00:00Z"); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := m.Save(ctx, "PAYM-1", `{"key":"PAYM-1","tasks":[]}`, "2026-09-06T10:05:00Z"); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	doc, ok, err := m.Get(ctx, "PAYM-1")
	if err != nil || !ok || doc != `{"key":"PAYM-1","tasks":[]}` {
		t.Fatalf("Get = (%q, %v, %v), want the last document", doc, ok, err)
	}
}
