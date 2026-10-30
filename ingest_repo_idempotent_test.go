package main

import (
	"path/filepath"
	"testing"
)

// A re-ingest passing the primary repo's SLUG (the plan queue did) instead of
// the canonical "" must replace the rows, not collide on blocks.id (PR 14461).
func TestReingestWithPrimarySlugIsIdempotent(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	blocks := []Block{{PR: 14461, File: "docker/unleash/flags.json", Name: "flags.json", Line: 1, EndLine: 9, Status: StatusModified, Side: SideNew}}

	if err := replacePRBlocks(db, "", 14461, blocks); err != nil {
		t.Fatal(err)
	}
	if err := replacePRBlocks(db, repoSlugFor(""), 14461, blocks); err != nil {
		t.Fatalf("re-ingest with slug: %v", err)
	}
	if err := upsertPRFileBlocks(db, repoSlugFor(""), 14461, []string{"docker/unleash/flags.json"}, blocks); err != nil {
		t.Fatalf("delta with slug: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM blocks WHERE pr = 14461`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows = %d, err %v; want 1", n, err)
	}
}
