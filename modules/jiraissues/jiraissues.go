// Package jiraissues is the read-model behind the non-PR issue section of
// /pr-overview — the reviewer's own sprint work, in one list whose planning
// rows sit above its todo rows (see jira_issues.go). It owns a tiny SQLite
// table holding ONE row: the latest snapshot of that list, plus the reason it
// is empty when a fetch failed.
//
// One row, not one per repo like modules/inbox: these issues are assigned to
// the reviewer (`assignee = currentUser()`), so the list is per-USER and has
// no repo to key on — the same reasoning that makes jira_inbox a single
// process-wide tracker rather than one per repo.
//
// Its WRITE method (Save) is driven only by the jira_issues tracker's Activity
// (per the project rule that only workflows mutate state); its READ method
// (Get) backs the read-only GET /api/jira/issues. The list is stored as opaque
// JSON so this module stays decoupled from the main package's row types,
// exactly like modules/inbox's sections/statuses.
//
// The table used to hold TWO lists (planning_json/todo_json), one per section.
// Those sections were merged into one list, so the table was replaced rather
// than migrated column by column: this row is derived state that the tracker
// rebuilds on its very next tick (and once at startup), so dropping the old
// one costs nothing a refresh does not restore.
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

DROP TABLE IF EXISTS jira_issues;

CREATE TABLE IF NOT EXISTS jira_issue_list (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at  TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  error       TEXT NOT NULL DEFAULT ''
);
`

// Snapshot is the latest state of the list. Issues is an opaque JSON array
// (the main package owns its row shape). Error is a short reason the list is
// empty (acli not logged in, SLASH_JIRA=off, …) — kept alongside the list
// rather than instead of it, so a failed refresh never blanks a perfectly
// usable previous snapshot.
type Snapshot struct {
	UpdatedAt string          `json:"updatedAt"`
	Issues    json.RawMessage `json:"issues"`
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
	issues := s.Issues
	if len(issues) == 0 {
		issues = json.RawMessage("[]")
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO jira_issue_list (id, updated_at, issues_json, error)
		 VALUES (1,?,?,?)`,
		s.UpdatedAt, string(issues), s.Error)
	return err
}

// Get returns the stored snapshot, or nil when nothing has been stored yet
// (a fresh install, or a first refresh still in flight). READ — safe for the
// UI.
func (m *Module) Get(ctx context.Context) (*Snapshot, error) {
	var s Snapshot
	var issues string
	err := m.db.QueryRowContext(ctx,
		`SELECT updated_at, issues_json, error FROM jira_issue_list WHERE id = 1`).
		Scan(&s.UpdatedAt, &issues, &s.Error)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Issues = json.RawMessage(issues)
	return &s, nil
}
