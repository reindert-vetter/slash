package tembed

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// sqliteDDL is the storage schema for the SQLite-backed Store.
const sqliteDDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  workflow   TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  type    TEXT NOT NULL,
  name    TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  error   TEXT NOT NULL DEFAULT '',
  time    TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
`

// SQLiteStore persists runs and events in a SQLite database (via the pure-Go
// modernc.org/sqlite driver, so no cgo / build step). Appending an event or
// changing a status is a single-row INSERT/UPDATE.
type SQLiteStore struct{ db *sql.DB }

// NewSQLiteStore opens (or creates) the DB at path and applies the schema.
func NewSQLiteStore(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("tembed: open sqlite: %w", err)
	}
	if _, err := db.Exec(sqliteDDL); err != nil {
		db.Close()
		return nil, fmt.Errorf("tembed: apply schema: %w", err)
	}
	return &SQLiteStore{db: db}, nil
}

// NewSQLiteStoreDB wraps an already-open *sql.DB (e.g. the host app's DB) and
// applies the schema, so tembed can share one DB file with its host.
func NewSQLiteStoreDB(db *sql.DB) (*SQLiteStore, error) {
	if _, err := db.Exec(sqliteDDL); err != nil {
		return nil, fmt.Errorf("tembed: apply schema: %w", err)
	}
	return &SQLiteStore{db: db}, nil
}

const tsLayout = time.RFC3339Nano

func (s *SQLiteStore) CreateRun(r RunRecord) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO runs (id, workflow, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		r.ID, r.Workflow, r.Status, r.CreatedAt.Format(tsLayout), r.UpdatedAt.Format(tsLayout))
	return err
}

func (s *SQLiteStore) SetStatus(runID, status string, at time.Time) error {
	_, err := s.db.Exec(
		`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`,
		status, at.Format(tsLayout), runID)
	return err
}

func (s *SQLiteStore) AppendEvent(runID string, e Event) error {
	_, err := s.db.Exec(
		`INSERT INTO events (run_id, seq, type, name, payload, error, time)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		runID, e.Seq, string(e.Type), e.Name, string(e.Payload), e.Error, e.Time.Format(tsLayout))
	if err != nil && isUniqueConstraintErr(err) {
		return ErrDuplicateEvent
	}
	return err
}

// isUniqueConstraintErr reports whether err is a SQLite UNIQUE constraint
// violation (e.g. two writers racing to insert the same (run_id, seq)).
// modernc.org/sqlite wraps the driver error without a portable typed
// sentinel we can rely on across versions, so we match on the message —
// the same phrase that used to reach the caller unfiltered.
func isUniqueConstraintErr(err error) bool {
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func (s *SQLiteStore) LoadRun(runID string) (RunRecord, []Event, error) {
	var r RunRecord
	var created, updated string
	err := s.db.QueryRow(
		`SELECT id, workflow, status, created_at, updated_at FROM runs WHERE id = ?`, runID).
		Scan(&r.ID, &r.Workflow, &r.Status, &created, &updated)
	if err == sql.ErrNoRows {
		return RunRecord{}, nil, fmt.Errorf("tembed: run %s not found", runID)
	}
	if err != nil {
		return RunRecord{}, nil, err
	}
	r.CreatedAt, _ = time.Parse(tsLayout, created)
	r.UpdatedAt, _ = time.Parse(tsLayout, updated)

	rows, err := s.db.Query(
		`SELECT seq, type, name, payload, error, time FROM events WHERE run_id = ? ORDER BY seq`, runID)
	if err != nil {
		return RunRecord{}, nil, err
	}
	defer rows.Close()
	var evs []Event
	for rows.Next() {
		var e Event
		var typ, payload, ts string
		if err := rows.Scan(&e.Seq, &typ, &e.Name, &payload, &e.Error, &ts); err != nil {
			return RunRecord{}, nil, err
		}
		e.Type = EventType(typ)
		if payload != "" {
			e.Payload = json.RawMessage(payload)
		}
		e.Time, _ = time.Parse(tsLayout, ts)
		evs = append(evs, e)
	}
	return r, evs, rows.Err()
}

func (s *SQLiteStore) ListRuns() ([]RunRecord, error) {
	rows, err := s.db.Query(
		`SELECT id, workflow, status, created_at, updated_at FROM runs ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RunRecord
	for rows.Next() {
		var r RunRecord
		var created, updated string
		if err := rows.Scan(&r.ID, &r.Workflow, &r.Status, &created, &updated); err != nil {
			return nil, err
		}
		r.CreatedAt, _ = time.Parse(tsLayout, created)
		r.UpdatedAt, _ = time.Parse(tsLayout, updated)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) Close() error { return s.db.Close() }
