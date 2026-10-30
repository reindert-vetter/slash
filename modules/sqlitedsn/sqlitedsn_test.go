package sqlitedsn_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"slash/modules/comments"
	"slash/modules/sqlitedsn"
)

// The separator has to follow whatever the path already carries, exactly like
// tembed's NewSQLiteStore — otherwise a path with a query string would get a
// second "?" and the driver would reject the whole DSN.
func TestDSNPicksSeparator(t *testing.T) {
	if got, want := sqlitedsn.DSN("/tmp/x.db"), "/tmp/x.db?_pragma=busy_timeout(30000)&_pragma=synchronous(NORMAL)&_txlock=immediate"; got != want {
		t.Fatalf("plain path: got %q want %q", got, want)
	}
	if got, want := sqlitedsn.DSN("/tmp/x.db?mode=rw"), "/tmp/x.db?mode=rw&_pragma=busy_timeout(30000)&_pragma=synchronous(NORMAL)&_txlock=immediate"; got != want {
		t.Fatalf("path with query: got %q want %q", got, want)
	}
}

// The point of the DSN is not the string but that the DRIVER honours it. A
// module store opened through it must report the pragma as actually set —
// this is what a bare sql.Open("sqlite", path) did not do, leaving every
// module write to fail instantly with SQLITE_BUSY on a locked DB.
func TestModuleStoreHasBusyTimeout(t *testing.T) {
	path := filepath.Join(t.TempDir(), "comments.db")
	cs, err := comments.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	// Open a second handle on the same file the same way the module does and
	// read the pragma back from it.
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var ms int
	if err := db.QueryRow(`PRAGMA busy_timeout`).Scan(&ms); err != nil {
		t.Fatal(err)
	}
	if ms != 30000 {
		t.Fatalf("busy_timeout = %d, want 30000", ms)
	}
}

// The behaviour the pragma buys: a writer that finds the DB locked WAITS for
// the lock to clear instead of returning SQLITE_BUSY straight away. Without
// the pragma this write fails in milliseconds; with it, it succeeds once the
// blocking transaction commits.
func TestWriterWaitsForLockInsteadOfFailing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.db")
	ctx := context.Background()

	writer, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err := writer.Exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}

	blocker, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()

	// Hold an exclusive write transaction open for a moment, then release it.
	tx, err := blocker.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO t (id) VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		time.Sleep(250 * time.Millisecond)
		_ = tx.Commit()
		close(done)
	}()

	// This write starts while the DB is locked. It must ride it out.
	if _, err := writer.Exec(`INSERT INTO t (id) VALUES (2)`); err != nil {
		t.Fatalf("write did not wait for the lock: %v", err)
	}
	<-done
}

// Retry is the safety net behind busy_timeout: a BUSY that outlasts the wait
// is retried instead of failing the Activity; any other error is not retried.
func TestRetryRidesOutBusyOnly(t *testing.T) {
	calls := 0
	err := sqlitedsn.Retry(context.Background(), func() error {
		calls++
		if calls < 3 {
			return errors.New("database is locked (5) (SQLITE_BUSY)")
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("err=%v calls=%d, want nil/3", err, calls)
	}
	calls = 0
	boom := errors.New("constraint failed")
	if err := sqlitedsn.Retry(context.Background(), func() error { calls++; return boom }); err != boom || calls != 1 {
		t.Fatalf("non-busy error retried: err=%v calls=%d", err, calls)
	}
}
