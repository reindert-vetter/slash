// Package prignore stores the PRs the reviewer ignores in the "Migrations & API
// changes" section of /pr-overview. One row per (repo, pr); un-ignoring deletes
// it. An ignore has no expiry and is not lifted by new activity.
//
// Its WRITE methods (Set/Clear) are driven only by the pr_ignore workflow's
// Activities (see .claude/rules/workflows-write-boundary.md); its READ method
// (List) backs the read-only GET /api/prignores.
package prignore

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS pr_ignores (
  repo       TEXT    NOT NULL,
  pr         INTEGER NOT NULL,
  ignored_at TEXT    NOT NULL,
  PRIMARY KEY (repo, pr)
);
`

// Ignore is one stored ignore. Repo is the canonical repo string ("" for the
// primary repo, "owner/name" otherwise).
type Ignore struct {
	Repo      string    `json:"repo"`
	PR        int       `json:"pr"`
	IgnoredAt time.Time `json:"ignoredAt"`
}

// Module owns the ignore store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("prignore: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("prignore: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Set ignores (repo, pr), recorded at `at`. WRITE — workflow Activity only.
// Idempotent (an upsert), so replay is safe.
func (m *Module) Set(ctx context.Context, repo string, pr int, at time.Time) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO pr_ignores (repo, pr, ignored_at) VALUES (?, ?, ?)
		 ON CONFLICT(repo, pr) DO UPDATE SET ignored_at = excluded.ignored_at`,
		repo, pr, at.UTC().Format(time.RFC3339))
	return err
}

// Clear lifts the ignore on (repo, pr). WRITE — workflow Activity only.
// Idempotent.
func (m *Module) Clear(ctx context.Context, repo string, pr int) error {
	_, err := m.db.ExecContext(ctx, `DELETE FROM pr_ignores WHERE repo = ? AND pr = ?`, repo, pr)
	return err
}

// List returns every ignore, oldest first. READ — safe from anywhere.
func (m *Module) List(ctx context.Context) ([]Ignore, error) {
	rows, err := m.db.QueryContext(ctx, `SELECT repo, pr, ignored_at FROM pr_ignores ORDER BY ignored_at, repo, pr`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Ignore{}
	for rows.Next() {
		var i Ignore
		var at string
		if err := rows.Scan(&i.Repo, &i.PR, &at); err != nil {
			return nil, err
		}
		i.IgnoredAt, _ = time.Parse(time.RFC3339, at)
		out = append(out, i)
	}
	return out, rows.Err()
}
