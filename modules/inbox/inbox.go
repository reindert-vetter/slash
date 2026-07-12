// Package inbox is the PR-inbox read-model module/service. It owns its own store
// (a tiny SQLite table holding the latest inbox snapshot per repo) and does its
// own thing with the data: it is the durable, read-only cache the UI renders so
// the overview never has to call GitHub itself. Its WRITE method (Save) is driven
// only by the pr_inbox workflow's Activity (per the project rule: only workflows
// mutate state); its READ method (Get) backs the read-only UI.
//
// The snapshot payload (sections + per-PR statuses) is stored as opaque JSON so
// this module stays decoupled from the main package's row/section types.
package inbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS inbox (
  repo          TEXT PRIMARY KEY,
  generated_for TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  statuses_json TEXT NOT NULL
);
`

// Snapshot is the latest inbox state for one repo. Sections and Statuses are
// opaque JSON (the main package owns their shape).
type Snapshot struct {
	Repo         string          `json:"repo"`
	GeneratedFor string          `json:"generatedFor"`
	UpdatedAt    string          `json:"updatedAt"`
	Sections     json.RawMessage `json:"sections"`
	Statuses     json.RawMessage `json:"statuses"`
}

// Module is the inbox read-model service.
type Module struct{ db *sql.DB }

// Open opens (or creates) the inbox DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("inbox: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("inbox: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Save upserts the latest snapshot for a repo. WRITE — workflow-driven only.
func (m *Module) Save(ctx context.Context, s Snapshot) error {
	if s.UpdatedAt == "" {
		s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	sections := s.Sections
	if len(sections) == 0 {
		sections = json.RawMessage("[]")
	}
	statuses := s.Statuses
	if len(statuses) == 0 {
		statuses = json.RawMessage("{}")
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO inbox (repo, generated_for, updated_at, sections_json, statuses_json)
		 VALUES (?,?,?,?,?)`,
		s.Repo, s.GeneratedFor, s.UpdatedAt, string(sections), string(statuses))
	return err
}

// Get returns the snapshot for a repo, or nil when none has been stored yet.
// READ — safe for the UI.
func (m *Module) Get(ctx context.Context, repo string) (*Snapshot, error) {
	var s Snapshot
	var sections, statuses string
	err := m.db.QueryRowContext(ctx,
		`SELECT repo, generated_for, updated_at, sections_json, statuses_json
		 FROM inbox WHERE repo = ?`, repo).
		Scan(&s.Repo, &s.GeneratedFor, &s.UpdatedAt, &sections, &statuses)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Sections = json.RawMessage(sections)
	s.Statuses = json.RawMessage(statuses)
	return &s, nil
}
