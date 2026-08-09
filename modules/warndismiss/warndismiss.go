// Package warndismiss remembers which AI risk findings (code_warning) the
// reviewer has already dealt with, so a later run of the same check does not
// raise them again.
//
// Why it has to be durable: the risk check re-runs automatically on every
// ingest refresh that brings real new code, and supersedeFileWarnings wipes
// the previous run's findings for the files in scope before the fresh pass.
// So a finding the reviewer resolved (or deleted outright) came straight back
// as a new open comment on the next run — "ik kan ai waarschuwing niet
// resolven of verwijderen". Neither the comments read-model nor the workflow
// history can answer this: a deleted comment leaves no row at all, and a
// resolved one is deleted by the very supersede that precedes the next run.
//
// A dismissal is identified by (pr, file, Fingerprint(body)) — deliberately
// the finding's TEXT, not its line: the same risk re-reported after a commit
// usually shifts line, and the text is what the reviewer actually judged.
// Known limit, accepted: a model that REPHRASES the same risk produces a
// different fingerprint and surfaces again. Normalisation (lowercase,
// whitespace collapsed) catches the near-identical repeat, which is the
// common case since the same prompt over the same code yields near-identical
// wording.
//
// Its WRITE method (Add) is driven only by a workflow Activity (per the
// project rule: only workflows mutate state); its READ method (Fingerprints)
// is safe from anywhere. See .claude/rules/workflows-write-boundary.md.
package warndismiss

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS dismissed_warnings (
  pr          INTEGER NOT NULL,
  file        TEXT    NOT NULL,
  fingerprint TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (pr, file, fingerprint)
);
`

// Module owns the dismissed-findings store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the warndismiss DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("warndismiss: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("warndismiss: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("warndismiss: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Fingerprint is the stable identity of one finding's text: lowercased, with
// every run of whitespace collapsed to a single space, hashed. Exported
// because both sides need the exact same value — the writer (a dismissed
// comment's body) and the reader (a fresh finding's text).
func Fingerprint(text string) string {
	norm := strings.ToLower(strings.Join(strings.Fields(text), " "))
	if norm == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// Add records that the finding with this fingerprint, on this file of this
// PR, was dismissed. Idempotent (the PK swallows a repeat), so replaying the
// Activity that calls it is safe. An empty fingerprint (an empty finding
// body) is ignored — it would match every other empty one. WRITE: call only
// from a workflow Activity.
func (m *Module) Add(ctx context.Context, pr int, file, fingerprint, at string) error {
	if fingerprint == "" {
		return nil
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO dismissed_warnings (pr, file, fingerprint, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(pr, file, fingerprint) DO NOTHING`, pr, file, fingerprint, at)
	return err
}

// Fingerprints returns every dismissed fingerprint of a PR, keyed by
// "<file>\x00<fingerprint>" so a caller can test one lookup per finding. READ
// — safe from anywhere.
func (m *Module) Fingerprints(ctx context.Context, pr int) (map[string]bool, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT file, fingerprint FROM dismissed_warnings WHERE pr = ?`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var file, fp string
		if err := rows.Scan(&file, &fp); err != nil {
			return nil, err
		}
		out[Key(file, fp)] = true
	}
	return out, rows.Err()
}

// Key builds the lookup key Fingerprints returns, so callers never spell the
// separator themselves.
func Key(file, fingerprint string) string { return file + "\x00" + fingerprint }
