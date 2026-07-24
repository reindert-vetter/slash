// Package tasksnooze is the task-snooze module/service. It owns its own store
// (a SQLite read-model of which tasks the reviewer chose to hide from the
// tasks inbox, and until when) and does its own thing with the data. Its
// WRITE method (Set) is driven only by workflow activities (per the project
// rule: only workflows mutate state); its READ method (List) backs the
// read-only UI. See .claude/rules/workflows-write-boundary.md and the skill
// add-module.
//
// Snooze is keyed by task_id (a generic task identifier, not a PR number) —
// this is the task-level successor of the removed per-PR ignore feature.
// Until is an absolute Unix-ms timestamp; 0 means "forever" (never expires).
// The expiry check itself happens at read time — the UI compares Until
// against Date.now() — so this module just stores what it's told and lists
// it back.
package tasksnooze

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS snoozes (
  task_id TEXT    NOT NULL PRIMARY KEY,
  until   INTEGER NOT NULL
);
`

// Snooze is one snoozed task: its id and the absolute Unix-ms timestamp until
// which it stays hidden (0 = forever).
type Snooze struct {
	TaskID string `json:"taskId"`
	Until  int64  `json:"until"`
}

// Module owns the task-snooze store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the tasksnooze DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("tasksnooze: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("tasksnooze: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("tasksnooze: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Set upserts a snooze for taskID with the given absolute expiry (Unix-ms; 0 =
// forever), or — when until < 0 — deletes the row (un-snooze). WRITE — call
// only from a workflow Activity. Idempotent (re-applying the same value is a
// no-op), so replay is safe.
func (m *Module) Set(ctx context.Context, taskID string, until int64) error {
	if until < 0 {
		_, err := m.db.ExecContext(ctx,
			`DELETE FROM snoozes WHERE task_id = ?`, taskID)
		return err
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO snoozes (task_id, until) VALUES (?,?)`,
		taskID, until)
	return err
}

// List returns every snoozed task, ordered deterministically. READ — safe for
// the UI/API. It does NOT filter expired entries: the expiry check is a
// read-time concern handled by the UI (Until vs. Date.now()).
func (m *Module) List(ctx context.Context) ([]Snooze, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT task_id, until FROM snoozes ORDER BY task_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Snooze
	for rows.Next() {
		var sn Snooze
		if err := rows.Scan(&sn.TaskID, &sn.Until); err != nil {
			return nil, err
		}
		out = append(out, sn)
	}
	return out, rows.Err()
}
