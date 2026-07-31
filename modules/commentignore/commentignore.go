// Package commentignore is the comment-ignore module/service. It owns its own
// store (a SQLite read-model of which PR-wide comments the reviewer chose to
// hide from the block index) and does its own thing with the data. Its WRITE
// method (Set) is driven only by workflow activities (per the project rule:
// only workflows mutate state); its READ method (List) backs the read-only UI.
// See .claude/rules/workflows-write-boundary.md and the skill add-module.
//
// Keyed by (pr, comment_id) rather than by comment_id alone. A comment id is
// globally unique, so a repo-wide key would work too — but the natural
// lifecycle of this data is the PR's: the cleanup workflow purges a
// long-merged PR by calling Purge(ctx, pr) on every module with a pr column,
// and a repo-wide key would leave every ignored comment of every purged PR
// behind forever with no way to find it again. See "Snoozing a task" in
// .claude/rules/tembed-workflows.md for the per-repo sibling (task_snooze),
// which has no such cleanup hook.
//
// Deliberately a plain on/off flag with no expiry, unlike tasksnooze's Until:
// "ignored" belongs with "resolved"/"approved" — reviewer decisions that never
// lapse by themselves — not with "snoozed", which is temporary by definition.
package commentignore

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS comment_ignores (
  pr         INTEGER NOT NULL,
  comment_id TEXT    NOT NULL,
  PRIMARY KEY (pr, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_ignores_pr ON comment_ignores(pr);
`

// Module owns the comment-ignore store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the commentignore DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("commentignore: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("commentignore: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("commentignore: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Set marks a comment of a PR as ignored, or removes that mark again. WRITE —
// call only from a workflow Activity. Idempotent in both directions
// (INSERT OR IGNORE / an unconditional DELETE), so replay is safe.
//
// Deliberately accepted: nothing here checks that commentID still refers to a
// live comment, so ignoring a comment that is deleted afterwards leaves an
// orphan row until the PR itself is purged. That is harmless rather than a bug
// — the frontend only ever matches these ids against the comments it actually
// loaded, so an orphan is invisible; cleaning it up eagerly would mean giving
// the comment-delete path a dependency on this module for no visible gain.
func (m *Module) Set(ctx context.Context, pr int, commentID string, ignored bool) error {
	if !ignored {
		_, err := m.db.ExecContext(ctx,
			`DELETE FROM comment_ignores WHERE pr = ? AND comment_id = ?`, pr, commentID)
		return err
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO comment_ignores (pr, comment_id) VALUES (?,?)`,
		pr, commentID)
	return err
}

// List returns the ignored comment ids of one PR, ordered deterministically.
// READ — safe for the UI/API.
func (m *Module) List(ctx context.Context, pr int) ([]string, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT comment_id FROM comment_ignores WHERE pr = ? ORDER BY comment_id`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Purge removes every ignored-comment row of one PR and reports how many rows
// went. WRITE — called by the cleanup workflow's purge Activity once a PR has
// been merged long enough. Unconditional on pr, so re-running it is a no-op.
func (m *Module) Purge(ctx context.Context, pr int) (int64, error) {
	res, err := m.db.ExecContext(ctx,
		`DELETE FROM comment_ignores WHERE pr = ?`, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
