// Package autowarn is the on/off preference for the AUTOMATIC AI risk check
// (code_warning): one repo-wide flag, "does an ingest/rebuild that finds real
// new code also auto-start a fresh code_warning run?" It does its own thing
// with the data, mirrors tasksnooze in shape (one Execution per repo, no PR
// scope). Its WRITE method (SetEnabled) is driven only by a workflow Activity
// (per the project rule: only workflows mutate state); its READ method
// (Enabled) backs the read-only GET /api/autowarn and the auto-trigger check
// itself. See .claude/rules/workflows-write-boundary.md and the skill
// add-module.
//
// Deliberately NOT localStorage/settings.json: the toggle gates BACKEND
// behaviour (a workflow Activity decides whether to fire), so the server must
// be able to read the current value the instant the trigger wants to run —
// unlike the dark/light theme (a pure frontend preference) or settings.json
// (read once per process, a restart to take effect). A manual "Diepgravend
// onderzoek" from the "/" menu is NEVER gated by this — only the automatic
// trigger checks it.
//
// Default is ENABLED (true) when nothing was ever saved: "always generate
// unless a reviewer explicitly turned it off" — see the "Bijgewerkt plan"
// / user's own words in the workflows-analysis.md AI-risicocontrole section.
package autowarn

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS auto_warn (
  repo    TEXT    NOT NULL PRIMARY KEY,
  enabled INTEGER NOT NULL
);
`

// Module owns the auto-warn preference store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the autowarn DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("autowarn: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("autowarn: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("autowarn: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Enabled reports whether the automatic code_warning trigger is turned on for
// repo. Defaults to true (enabled) when no preference was ever saved. READ —
// safe from anywhere, including directly from an Activity (see
// TaskManager.autoStartCodeWarning).
func (m *Module) Enabled(ctx context.Context, repo string) (bool, error) {
	var v int
	err := m.db.QueryRowContext(ctx, `SELECT enabled FROM auto_warn WHERE repo = ?`, repo).Scan(&v)
	if err == sql.ErrNoRows {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return v != 0, nil
}

// SetEnabled persists the on/off preference for repo. WRITE — call only from
// a workflow Activity. Idempotent (re-applying the same value is a no-op), so
// replay is safe.
func (m *Module) SetEnabled(ctx context.Context, repo string, enabled bool) error {
	v := 0
	if enabled {
		v = 1
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO auto_warn (repo, enabled) VALUES (?, ?)
		 ON CONFLICT(repo) DO UPDATE SET enabled = excluded.enabled`, repo, v)
	return err
}
