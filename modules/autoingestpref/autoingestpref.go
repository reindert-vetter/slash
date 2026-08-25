// Package autoingestpref is the reviewer's repo-wide preference for AUTOMATIC
// review-tree generation ("mijn eigen prs, daarvan mogen de trees automatisch
// worden gegenereerd"): does the pr_inbox tracker's own refresh also start an
// ingest for a not-yet-generated PR, and for whose PRs? One Execution per
// repo, no PR scope — the same per-repo-tracker mould as modules/autowarn.
//
// Three states, not a boolean (mirrors theme.mjs's system/light/dark shape,
// but the content is unrelated):
//
//   - "off" — never automatic; the reviewer always clicks "Generate review
//     tree" by hand (the pre-existing behaviour).
//   - "own" — automatic only for PRs the reviewer authored (default).
//   - "all" — automatic for every PR the inbox shows, including PRs from
//     other authors (e.g. "Needs your review" — a tree is ready before the
//     reviewer even opens it).
//
// Its WRITE method (SetMode) is driven only by a workflow Activity (per the
// project rule: only workflows mutate state); its READ method (Mode) backs
// the read-only GET /api/autoingestpref and the auto-trigger check itself
// (TaskManager.autoIngestOwnPRs). See .claude/rules/workflows-write-boundary.md
// and the skill add-module.
//
// Deliberately NOT localStorage/settings.json, same reasoning as autowarn:
// this gates BACKEND behaviour (the refreshInbox Activity decides, at the
// moment it runs, whether to auto-ingest a PR), so the server must be able to
// read the current value instantly — unlike a pure frontend preference or a
// once-per-process file read.
//
// Default is "own" when nothing was ever saved — the reviewer's own explicit
// request: auto-generate your own PRs without any further action, opt-out
// rather than opt-in.
package autoingestpref

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS auto_ingest_pref (
  repo TEXT NOT NULL PRIMARY KEY,
  mode TEXT NOT NULL
);
`

// ModeOff/ModeOwn/ModeAll are the three valid preference values. Any other
// stored/incoming string is rejected by the caller before it reaches here
// (see the validation in workflows.go/tasks_api.go) — this package itself
// only ever reads/writes whatever string it's given.
const (
	ModeOff = "off"
	ModeOwn = "own"
	ModeAll = "all"
)

// Module owns the auto-ingest-preference store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("autoingestpref: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("autoingestpref: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("autoingestpref: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Mode reports the current preference for repo. Defaults to ModeOwn when no
// preference was ever saved. READ — safe from anywhere, including directly
// from an Activity (see TaskManager.autoIngestOwnPRs).
func (m *Module) Mode(ctx context.Context, repo string) (string, error) {
	var v string
	err := m.db.QueryRowContext(ctx, `SELECT mode FROM auto_ingest_pref WHERE repo = ?`, repo).Scan(&v)
	if err == sql.ErrNoRows {
		return ModeOwn, nil
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

// SetMode persists the preference for repo. WRITE — call only from a
// workflow Activity. Idempotent (re-applying the same value is a no-op), so
// replay is safe.
func (m *Module) SetMode(ctx context.Context, repo, mode string) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO auto_ingest_pref (repo, mode) VALUES (?, ?)
		 ON CONFLICT(repo) DO UPDATE SET mode = excluded.mode`, repo, mode)
	return err
}
