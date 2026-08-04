// Package warnrevoke remembers which (pr, block, row) combinations already
// had their reviewer approval retracted because of an AI risk-check
// (code_warning) finding — so a re-run that surfaces the SAME warning on the
// SAME row a second (third, ...) time does not retract an approval the
// reviewer deliberately gave again after seeing it once. Its WRITE method
// (MarkIfNew) is driven only by a workflow Activity (per the project rule:
// only workflows mutate state); it has no read-only UI consumer, but still
// follows the same module shape for consistency. See
// .claude/rules/workflows-write-boundary.md and the skill add-module.
//
// Identity is deliberately (pr, block_id, row) — the ANCHOR the warning sits
// on — never the comment id (a stale one is deleted and a fresh one created
// on every code_warning run via supersedeFileWarnings, see code_warning.go)
// and never the finding's own wording/timestamp (the model may rephrase the
// same underlying issue between runs). "The same row already triggered a
// revoke once" is what decides, not "is this literally the same sentence".
package warnrevoke

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS warning_revocations (
  pr       INTEGER NOT NULL,
  block_id TEXT    NOT NULL,
  row      INTEGER NOT NULL,
  PRIMARY KEY (pr, block_id, row)
);
`

// Module owns the warning-revocation bookkeeping store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the warnrevoke DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("warnrevoke: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("warnrevoke: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("warnrevoke: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// MarkIfNew records that (pr, blockID, row) triggered an approval revoke, and
// reports whether this is the FIRST time (true — the caller should actually
// revoke) or it was already marked before (false — a repeat of the same
// warning on the same row, the reviewer's later approval stands). WRITE — call
// only from a workflow Activity. Idempotent: calling it again for the same key
// keeps reporting false, so replay is safe.
func (m *Module) MarkIfNew(ctx context.Context, pr int, blockID string, row int) (bool, error) {
	res, err := m.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO warning_revocations (pr, block_id, row) VALUES (?, ?, ?)`,
		pr, blockID, row)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Purge removes every warnrevoke row of pr. WRITE — workflow-only, the per-PR
// data-retention cleanup path (see the cleanup workflow). Returns the number
// of rows removed, for logging.
func (m *Module) Purge(ctx context.Context, pr int) (int64, error) {
	res, err := m.db.ExecContext(ctx, `DELETE FROM warning_revocations WHERE pr = ?`, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
