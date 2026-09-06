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
	"strings"
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
	if _, err := db.Exec(chatCheckoutStoreSchema + planCheckoutStoreSchema); err != nil {
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

// ---------------------------------------------------------------------------
// Per-PLAN werkmap (plan_execute.go)
//
// Same cache-hint reasoning as the per-PR table above, keyed by the Jira issue
// key instead of a PR number, because a plan execution runs BEFORE any PR
// exists. It exists for one concrete failure: after an attempt, the werkmap
// sits on the plan's own branch with a commit origin/<base> does not have, so
// listCheckoutCandidates classifies it as "someone else's unfinished work"
// (diag.Busy) and never offers it again — a second execution of the same plan
// would silently land in a DIFFERENT directory, or in none at all. Remembering
// the directory per plan key is what makes "per plan naar dezelfde map" hold.
//
// Losing a row costs one extra run of the selection ladder, nothing more.
// ---------------------------------------------------------------------------

const planCheckoutStoreSchema = `
CREATE TABLE IF NOT EXISTS plan_checkout (
  key    TEXT NOT NULL PRIMARY KEY,
  dir    TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT ''
);
`

// loadPersistedPlanCheckout returns the werkmap last used for this plan key.
// ok is false when nothing was saved, the saved dir is empty, or persistence
// is unavailable — every case where the ladder should simply run fresh.
func loadPersistedPlanCheckout(dataDir, key string) (dir, branch string, ok bool) {
	db := chatCheckoutStoreFor(dataDir)
	if db == nil || strings.TrimSpace(key) == "" {
		return "", "", false
	}
	err := db.QueryRow(`SELECT dir, branch FROM plan_checkout WHERE key = ?`, key).Scan(&dir, &branch)
	if err != nil || dir == "" {
		return "", "", false
	}
	return dir, branch, true
}

// savePersistedPlanCheckout durably remembers the werkmap of a plan key.
// dir == "" removes the row. Best-effort, exactly like its per-PR sibling.
func savePersistedPlanCheckout(dataDir, key, dir, branch string) {
	db := chatCheckoutStoreFor(dataDir)
	if db == nil || strings.TrimSpace(key) == "" {
		return
	}
	if dir == "" {
		_, _ = db.Exec(`DELETE FROM plan_checkout WHERE key = ?`, key)
		return
	}
	_, _ = db.Exec(`INSERT INTO plan_checkout (key, dir, branch) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET dir = excluded.dir, branch = excluded.branch`,
		key, dir, branch)
}
