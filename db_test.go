package main

import (
	"path/filepath"
	"testing"
)

// The blocks DB has the same concurrent writers as every module store (an
// ingest/refresh Activity writing while a request reads), so it needs the same
// busy_timeout — without it one of them fails on the spot with SQLITE_BUSY
// instead of waiting out the lock. Asserts the pragma the DRIVER actually
// applied, not the DSN string. See modules/sqlitedsn.
func TestOpenDBHasBusyTimeout(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var ms int
	if err := db.QueryRow(`PRAGMA busy_timeout`).Scan(&ms); err != nil {
		t.Fatal(err)
	}
	if ms != 5000 {
		t.Fatalf("busy_timeout = %d, want 5000", ms)
	}
}
