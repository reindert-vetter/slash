// Package ignore is the PR-ignore module/service. It owns its own store (a
// SQLite read-model of which PRs the reviewer chose to hide from the inbox, and
// until when) and does its own thing with the data. Its WRITE method (Set) is
// driven only by workflow activities (per the project rule: only workflows
// mutate state); its READ method (List) backs the read-only UI. See
// .claude/rules/workflows-write-boundary.md and the skill add-module.
//
// Ignore is per-repo: one row per (repo, pr). Until is an absolute Unix-ms
// timestamp; 0 means "forever" (never expires). The expiry check itself happens
// at read time — the UI compares Until against Date.now() — so this module just
// stores what it's told and lists it back.
package ignore

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS ignores (
  repo  TEXT    NOT NULL,
  pr    INTEGER NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (repo, pr)
);

CREATE INDEX IF NOT EXISTS idx_ignores_repo ON ignores(repo);
`

// Ignore is one ignored PR: its number and the absolute Unix-ms timestamp until
// which it stays hidden (0 = forever).
type Ignore struct {
	PR    int   `json:"pr"`
	Until int64 `json:"until"`
}

// Module owns the ignore store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the ignore DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("ignore: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("ignore: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("ignore: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Set upserts an ignore for (repo, pr) with the given absolute expiry (Unix-ms;
// 0 = forever), or — when until < 0 — deletes the row (un-ignore). WRITE — call
// only from a workflow Activity. Idempotent (re-applying the same value is a
// no-op), so replay is safe.
func (m *Module) Set(ctx context.Context, repo string, pr int, until int64) error {
	if until < 0 {
		_, err := m.db.ExecContext(ctx,
			`DELETE FROM ignores WHERE repo = ? AND pr = ?`, repo, pr)
		return err
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO ignores (repo, pr, until) VALUES (?,?,?)`,
		repo, pr, until)
	return err
}

// List returns every ignored PR for a repo, ordered deterministically. READ —
// safe for the UI/API. It does NOT filter expired entries: the expiry check is
// a read-time concern handled by the UI (Until vs. Date.now()).
func (m *Module) List(ctx context.Context, repo string) ([]Ignore, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT pr, until FROM ignores WHERE repo = ? ORDER BY pr`, repo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Ignore
	for rows.Next() {
		var ig Ignore
		if err := rows.Scan(&ig.PR, &ig.Until); err != nil {
			return nil, err
		}
		out = append(out, ig)
	}
	return out, rows.Err()
}
