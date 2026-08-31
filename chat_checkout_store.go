// chat_checkout_store.go — durable dir/branch persistence for a PR's assigned
// checkout, so a server restart doesn't drop the checkout chip onto "Geen
// werkmap" for a PR whose chat already shows landed edits.
//
// Root cause this fixes: chatCheckoutAssignment (chat_checkout.go) lived only
// in a package-level in-memory map. buildCheckoutView, the read model behind
// GET /api/chat/checkout, read only that map — so a process restart made it
// forget which directory a PR was using, even though the git checkout itself
// (with the landed, unpushed commit) was still sitting right there on disk.
//
// This is deliberately a direct, synchronous write OUTSIDE any workflow
// Activity — the same operational carve-out as pendingPushStatus/
// comment_batch_progress (see .claude/rules/workflows-write-boundary.md),
// extended to a tiny durable cache instead of an in-memory one: the durable
// TRUTH is still the git checkout itself (which directory is on which
// branch, in what state — chat_checkout.go's own classifyCheckoutCandidate
// re-verifies that on every real use, before a write turn actually commits
// anything). This table is only a CACHE HINT telling the process, before it
// has re-derived anything, which directory to look at first. Losing or
// corrupting a row costs nothing but re-running the selection ladder once —
// a workflow Execution would be the wrong tool for a value this cheap to
// regenerate, so don't "fix" this into one.
package main

import (
	"database/sql"
	"sync"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const chatCheckoutStoreSchema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS chat_checkout (
  repo   TEXT    NOT NULL,
  pr     INTEGER NOT NULL,
  dir    TEXT    NOT NULL DEFAULT '',
  branch TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (repo, pr)
);
`

var (
	chatCheckoutStoreMu sync.Mutex
	chatCheckoutStoreDB = map[string]*sql.DB{}
)

// chatCheckoutStoreFor lazily opens (and caches, per dataDir) the small
// SQLite DB backing the persisted dir/branch. Returns nil when dataDir is
// empty (a caller/test that never wired one up) or the open/schema step
// fails — every function below treats a nil db as "persistence unavailable"
// and falls back to the pre-existing in-memory-only behaviour rather than
// failing its caller.
func chatCheckoutStoreFor(dataDir string) *sql.DB {
	if dataDir == "" {
		return nil
	}
	chatCheckoutStoreMu.Lock()
	defer chatCheckoutStoreMu.Unlock()
	if db, ok := chatCheckoutStoreDB[dataDir]; ok {
		return db
	}
	db, err := sql.Open("sqlite", sqlitedsn.DSN(dataDir+"/chat_checkout.db"))
	if err != nil {
		return nil
	}
	if _, err := db.Exec(chatCheckoutStoreSchema); err != nil {
		db.Close()
		return nil
	}
	chatCheckoutStoreDB[dataDir] = db
	return db
}

// loadPersistedCheckout returns the last-saved dir/branch for repo/pr. ok is
// false when nothing was ever saved, the saved dir is empty, or persistence
// is unavailable — every case where the ladder should just run fresh.
func loadPersistedCheckout(dataDir, repo string, pr int) (dir, branch string, ok bool) {
	db := chatCheckoutStoreFor(dataDir)
	if db == nil {
		return "", "", false
	}
	err := db.QueryRow(`SELECT dir, branch FROM chat_checkout WHERE repo = ? AND pr = ?`, repo, pr).Scan(&dir, &branch)
	if err != nil || dir == "" {
		return "", "", false
	}
	return dir, branch, true
}

// savePersistedCheckout durably remembers repo/pr's currently assigned
// dir/branch. dir == "" removes the row (mirrors checkoutSetOff / a resolved
// "no checkout" outcome — nothing left worth remembering). Best-effort: an
// error here only costs the next restart one extra run of the selection
// ladder, so callers don't need to check it.
func savePersistedCheckout(dataDir, repo string, pr int, dir, branch string) {
	db := chatCheckoutStoreFor(dataDir)
	if db == nil {
		return
	}
	if dir == "" {
		_, _ = db.Exec(`DELETE FROM chat_checkout WHERE repo = ? AND pr = ?`, repo, pr)
		return
	}
	_, _ = db.Exec(`INSERT INTO chat_checkout (repo, pr, dir, branch) VALUES (?, ?, ?, ?)
		ON CONFLICT(repo, pr) DO UPDATE SET dir = excluded.dir, branch = excluded.branch`,
		repo, pr, dir, branch)
}
