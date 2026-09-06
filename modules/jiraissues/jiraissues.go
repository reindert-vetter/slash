// Package jiraissues is the read-model behind the two non-PR sections of
// /pr-overview — "Planning" (the active sprint) and "Todo" (the queue feeding
// it). It owns a tiny SQLite table holding ONE row: the latest snapshot of
// both lists, plus the reason they are empty when a fetch failed.
//
// One row, not one per repo like modules/inbox: these issues are assigned to
// the reviewer (`assignee = currentUser()`), so the list is per-USER and has
// no repo to key on — the same reasoning that makes jira_inbox a single
// process-wide tracker rather than one per repo.
//
// Its WRITE method (Save) is driven only by the jira_issues tracker's Activity
// (per the project rule that only workflows mutate state); its READ method
// (Get) backs the read-only GET /api/jira/issues. The two lists are stored as
// opaque JSON so this module stays decoupled from the main package's row
// types, exactly like modules/inbox's sections/statuses.
package jiraissues

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS jira_issues (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at    TEXT NOT NULL,
  planning_json TEXT NOT NULL,
  todo_json     TEXT NOT NULL,
  error         TEXT NOT NULL DEFAULT ''
);
`

// Snapshot is the latest state of both lists. Planning and Todo are opaque
// JSON arrays (the main package owns their shape). Error is a short reason the
// lists are empty (acli not logged in, SLASH_JIRA=off, …) — kept alongside the
// lists rather than instead of them, so a failed refresh never blanks a
// perfectly usable previous snapshot.
type Snapshot struct {
	UpdatedAt string          `json:"updatedAt"`
	Planning  json.RawMessage `json:"planning"`
	Todo      json.RawMessage `json:"todo"`
	Error     string          `json:"error,omitempty"`
}

// Module is the Jira-issues read-model service.
type Module struct{ db *sql.DB }

// Open opens (or creates) the jira-issues DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("jiraissues: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("jiraissues: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Save replaces the single stored snapshot. WRITE — workflow-driven only.
func (m *Module) Save(ctx context.Context, s Snapshot) error {
	if s.UpdatedAt == "" {
		s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	planning := s.Planning
	if len(planning) == 0 {
		planning = json.RawMessage("[]")
	}
	todo := s.Todo
	if len(todo) == 0 {
		todo = json.RawMessage("[]")
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO jira_issues (id, updated_at, planning_json, todo_json, error)
		 VALUES (1,?,?,?,?)`,
		s.UpdatedAt, string(planning), string(todo), s.Error)
	return err
}

// Get returns the stored snapshot, or nil when nothing has been stored yet
// (a fresh install, or a first refresh still in flight). READ — safe for the
// UI.
func (m *Module) Get(ctx context.Context) (*Snapshot, error) {
	var s Snapshot
	var planning, todo string
	err := m.db.QueryRowContext(ctx,
		`SELECT updated_at, planning_json, todo_json, error FROM jira_issues WHERE id = 1`).
		Scan(&s.UpdatedAt, &planning, &todo, &s.Error)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Planning = json.RawMessage(planning)
	s.Todo = json.RawMessage(todo)
	return &s, nil
}
