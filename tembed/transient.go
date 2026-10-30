package tembed

import (
	"context"
	"strings"
	"time"
)

// IsTransientDBError reports SQLite lock contention (SQLITE_BUSY/SQLITE_LOCKED).
// A plain substring match: neither database/sql nor the modernc driver exposes
// a typed error, and an Activity wraps it with fmt.Errorf anyway.
func IsTransientDBError(err error) bool {
	if err == nil {
		return false
	}
	m := err.Error()
	return strings.Contains(m, "SQLITE_BUSY") || strings.Contains(m, "SQLITE_LOCKED") ||
		strings.Contains(m, "database is locked")
}

// retryTransient runs fn, retrying with a short backoff (about 15s in total)
// while it fails with a transient SQLite lock error. It sits BELOW the history:
// an Activity's outcome (completed/failed) is recorded only after the retries,
// so replay never sees the intermediate failures and stays deterministic.
// Safe because every slash write Activity is an idempotent upsert/replace, and
// a lock failure means the statement did not commit.
//
// TransientAttempts is a var only so a host test can set it to 1 and observe a
// single raw attempt; nothing else writes it.
var TransientAttempts = 10

func retryTransient(ctx context.Context, fn func() error) error {
	delay := 100 * time.Millisecond
	var err error
	for attempt := 0; attempt < TransientAttempts; attempt++ {
		if err = fn(); !IsTransientDBError(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(delay):
		}
		if delay < 2*time.Second {
			delay *= 2
		}
	}
	return err
}
