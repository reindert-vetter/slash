// Package touchai stores the AI read of a PR's migration/API changes — the
// impact label, the one-sentence summary and the per-chip verdicts the
// /pr-overview "Migrations & API changes" rows show next to the
// deterministic summary (see touch_ai.go and .claude/docs/pr-overview.md).
//
// Keyed per (repo, pr, head_sha): the patches only change with a push, so a
// result belongs to exactly one head commit, and a new push simply gets a new
// row (the reader asks for the current head SHA, so an old row is never
// shown for newer code).
//
// Its WRITE method (Save) is driven only by the touch_ai workflow's Activity
// (per the project rule: only workflows mutate state); its READ method (Get)
// is safe from anywhere. See .claude/rules/workflows-write-boundary.md.
package touchai

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS touch_ai (
  repo       TEXT    NOT NULL DEFAULT '',  -- canonical repo string: '' = the primary repo
  pr         INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  result     TEXT    NOT NULL,             -- JSON, opaque to this module
  updated_at TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (repo, pr, head_sha)
);
`

// Module owns the touch_ai store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the touchai DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("touchai: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("touchai: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Save upserts the result JSON for one PR head. Idempotent, so replaying the
// Activity that calls it is safe. WRITE: call only from a workflow Activity.
func (m *Module) Save(ctx context.Context, repo string, pr int, headSHA, result, at string) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO touch_ai (repo, pr, head_sha, result, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(repo, pr, head_sha) DO UPDATE SET result = excluded.result, updated_at = excluded.updated_at`,
		repo, pr, headSHA, result, at)
	return err
}

// Get returns the stored result JSON for one PR head ("" + false when there
// is none yet). READ — safe from anywhere.
func (m *Module) Get(ctx context.Context, repo string, pr int, headSHA string) (string, bool, error) {
	var out string
	err := m.db.QueryRowContext(ctx,
		`SELECT result FROM touch_ai WHERE repo = ? AND pr = ? AND head_sha = ?`, repo, pr, headSHA).Scan(&out)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return out, true, nil
}
