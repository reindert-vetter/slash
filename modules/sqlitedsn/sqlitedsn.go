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

import "strings"

// DSN returns path with the standard pragmas appended as query parameters.
// It picks the right separator so a path that already carries a query string
// keeps working, mirroring tembed's NewSQLiteStore.
func DSN(path string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + "_pragma=busy_timeout(5000)"
}
