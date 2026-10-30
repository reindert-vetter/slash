// Package sqlitedsn builds the SQLite DSN every module store opens with, so
// they all get the same connection pragmas from one place instead of each
// Open repeating (or, as happened here, silently omitting) them.
//
// Today that is exactly one pragma: busy_timeout. Without it a writer that
// finds the DB locked — another connection in database/sql's pool mid-write —
// fails IMMEDIATELY with SQLITE_BUSY instead of waiting and retrying, and for
// a module store that failure surfaces as a permanently FAILED workflow run
// ("save reaction: database is locked (5) (SQLITE_BUSY)" in GET /api/problems).
// That is terminal: engine.SignalWorkflow refuses a Signal on a failed run, so
// the thread it belonged to can never accept a reply again. tembed's own store
// has set this since it hit the same problem (see NewSQLiteStore in
// tembed/store_sqlite.go); the module stores never did, which is why every
// SQLITE_BUSY failure in the problems list came from a module write
// (comments, callresolve, …) and none from tembed itself.
//
// 5s matches tembed deliberately: long enough to ride out the concurrent
// writes this app actually produces (a poll landing on top of a reviewer's own
// write), short enough that a genuinely wedged DB still returns an error
// instead of hanging a request forever.
package sqlitedsn

import (
	"context"
	"strings"
	"time"
)

// DSN returns path with the standard pragmas appended as query parameters.
// It picks the right separator so a path that already carries a query string
// keeps working, mirroring tembed's NewSQLiteStore.
func DSN(path string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + Params
}

// Params are the connection parameters every store opens with. busy_timeout is
// 30s (a lock burst of dozens of resolve_call runs must wait, never fail),
// _txlock=immediate makes a write transaction take the write lock at BEGIN
// where busy_timeout applies (a deferred read-then-write upgrade returns BUSY
// at once and ignores it), and synchronous(NORMAL) is safe in WAL and shortens
// every commit, so the lock is held less long. tembed/store_sqlite.go repeats
// this string (tembed imports no slash package) — keep them in sync.
const Params = "_pragma=busy_timeout(30000)&_pragma=synchronous(NORMAL)&_txlock=immediate"

// IsBusy reports SQLite lock contention (SQLITE_BUSY / SQLITE_LOCKED).
func IsBusy(err error) bool {
	if err == nil {
		return false
	}
	m := err.Error()
	return strings.Contains(m, "SQLITE_BUSY") || strings.Contains(m, "SQLITE_LOCKED") ||
		strings.Contains(m, "database is locked")
}

// Retry runs fn and, as a safety net behind busy_timeout, retries it with a
// short backoff while it fails with lock contention. Call it INSIDE an
// Activity / module write (a side-effect boundary), never in a workflow body,
// so it stays deterministic (.claude/rules/workflow-determinism.md).
func Retry(ctx context.Context, fn func() error) error {
	delay := 50 * time.Millisecond
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		if err = fn(); !IsBusy(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(delay):
		}
		if delay < time.Second {
			delay *= 2
		}
	}
	return err
}
