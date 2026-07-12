// Package prmeta is the PR-metadata module/service: a small SQLite read-model of
// per-PR facts (its title + web URL) that the pr_status workflow fills at start.
// Its WRITE method (Save) is driven only by a workflow Activity (per the project
// rule: only workflows mutate state); its READ method (Get) backs the read-only
// UI — the `/` command menu's Jira/GitHub deep-links need the PR title (to derive
// the KEY-123 ticket) and its URL.
package prmeta

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS pr_meta (
  pr         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
`

// Meta is the stored metadata of one PR.
type Meta struct {
	PR        int    `json:"pr"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	UpdatedAt string `json:"updatedAt"`
}

// Module is the prmeta service (owns its own SQLite read-model).
type Module struct{ db *sql.DB }

// Open opens (or creates) the prmeta DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("prmeta: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("prmeta: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("prmeta: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Save upserts a PR's metadata (idempotent on pr). WRITE — workflow-driven only.
func (m *Module) Save(ctx context.Context, meta Meta) error {
	if meta.UpdatedAt == "" {
		meta.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO pr_meta (pr, title, url, updated_at) VALUES (?,?,?,?)`,
		meta.PR, meta.Title, meta.URL, meta.UpdatedAt)
	return err
}

// Get returns the stored metadata for pr (ok=false when none is stored yet).
// READ — safe for the UI.
func (m *Module) Get(ctx context.Context, pr int) (Meta, bool, error) {
	var meta Meta
	err := m.db.QueryRowContext(ctx,
		`SELECT pr, title, url, updated_at FROM pr_meta WHERE pr = ?`, pr).
		Scan(&meta.PR, &meta.Title, &meta.URL, &meta.UpdatedAt)
	if err == sql.ErrNoRows {
		return Meta{}, false, nil
	}
	if err != nil {
		return Meta{}, false, err
	}
	return meta, true, nil
}
