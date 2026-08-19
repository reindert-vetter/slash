// Package warnreviewed remembers, per file, the sha256 of the head content
// the code_warning check last successfully reviewed — so a later run of that
// same check can skip a file that hasn't changed since, instead of paying for
// another agentic Opus call on code the model already looked at.
//
// Reviewer request: "ik wil ai warnings alleen genereren op code wat niet
// eerder al gecontroleerd is door ai warnings flow".
//
// File-level, not line-level: the identity is (repo, pr, file) → the head
// content's hash. Any change anywhere in the file (even one unrelated line)
// invalidates the whole file, since that is the unit resolveWarningScope
// already reasons about (a file, not a line, enters or leaves review scope).
//
// A file that cannot be read when this run tries to hash it (missing,
// permission error, worktree not ready, …) must NEVER be treated as
// "unchanged" — see filesNeedingReview (code_warning.go), which only ever
// trusts a hash it could actually compute just now. Uncertainty always means
// "review it again", never "skip it silently".
//
// Its WRITE method (MarkReviewed) is driven only by a workflow Activity (per
// the project rule: only workflows mutate state); its READ method (Hashes) is
// safe from anywhere. See .claude/rules/workflows-write-boundary.md.
package warnreviewed

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS reviewed_files (
  repo        TEXT    NOT NULL DEFAULT '',  -- canonical repo string: '' = the primary repo
  pr          INTEGER NOT NULL,
  file        TEXT    NOT NULL,
  hash        TEXT    NOT NULL,
  reviewed_at TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (repo, pr, file)
);
`

// Module owns the reviewed-file store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the warnreviewed DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("warnreviewed: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("warnreviewed: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("warnreviewed: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// HashContent is the stable identity of a file's content: a plain sha256 hex
// digest of the raw bytes. Exported because both sides need the exact same
// value — the writer (the head content just reviewed) and the reader (the
// head content a later run finds).
func HashContent(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// MarkReviewed records that this file, at this exact hash, was successfully
// reviewed by code_warning for this PR — overwriting whatever hash was stored
// before. Idempotent (an upsert), so replaying the Activity that calls it is
// safe. An empty hash is ignored (nothing was actually read). WRITE: call
// only from a workflow Activity.
func (m *Module) MarkReviewed(ctx context.Context, repo string, pr int, file, hash, at string) error {
	if hash == "" {
		return nil
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO reviewed_files (repo, pr, file, hash, reviewed_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(repo, pr, file) DO UPDATE SET hash = excluded.hash, reviewed_at = excluded.reviewed_at`,
		repo, pr, file, hash, at)
	return err
}

// Hashes returns every file of a PR already reviewed, keyed by file, mapped
// to the hash it was last reviewed at. READ — safe from anywhere.
func (m *Module) Hashes(ctx context.Context, repo string, pr int) (map[string]string, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT file, hash FROM reviewed_files WHERE repo = ? AND pr = ?`, repo, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var file, hash string
		if err := rows.Scan(&file, &hash); err != nil {
			return nil, err
		}
		out[file] = hash
	}
	return out, rows.Err()
}
