// Package explanations is the AI code-explanation module/service: a SQLite
// read-model that stores, per navigation unit (a line/group selection inside a
// block), a short Dutch AI-generated description of the if-statement that unit
// contains. It backs the footer's "AI-omschrijving" line.
//
// A row is keyed by (pr, block_id, unit_key) — at most one live explanation per
// unit — and carries the code_hash of the exact unit+context text it was
// generated for, so the frontend ignores a stale row after the code changed
// (a new commit yields a new hash and a fresh explain_code run overwrites the
// row). A row seeded with an empty code_hash matches any hash (test fixtures).
//
// WRITE methods (SaveSearching/Save) are driven only by workflow Activities
// (per .claude/rules/workflows-write-boundary.md); the READ method (List)
// backs the read-only UI.
package explanations

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS explanations (
  pr         INTEGER NOT NULL,
  block_id   TEXT    NOT NULL,
  unit_key   TEXT    NOT NULL,
  code_hash  TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL,
  text       TEXT    NOT NULL DEFAULT '',
  model      TEXT    NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (pr, block_id, unit_key)
);

CREATE INDEX IF NOT EXISTS idx_explanations_pr ON explanations(pr);
`

// Status values.
const (
	StatusSearching = "searching" // an explain_code run is in progress
	StatusDone      = "done"      // the explanation text is ready
	StatusFailed    = "failed"    // the LLM returned nothing (offline/hiccup)
)

// Entry is one unit → explanation row.
type Entry struct {
	PR        int    `json:"pr"`
	BlockID   string `json:"blockId"`
	UnitKey   string `json:"unitKey"`
	CodeHash  string `json:"codeHash"`
	Status    string `json:"status"`
	Text      string `json:"text"`
	Model     string `json:"model"`
	UpdatedAt string `json:"updatedAt"`
}

// Module owns the explanations store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the explanations DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("explanations: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("explanations: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("explanations: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// SaveSearching marks a unit's explanation as in-progress (upserting over any
// previous row for the unit — a newer hash supersedes the stale text). WRITE —
// workflow-Activity-only.
func (m *Module) SaveSearching(ctx context.Context, e Entry) error {
	_, err := m.db.ExecContext(ctx, `
INSERT INTO explanations (pr, block_id, unit_key, code_hash, status, text, model, updated_at)
VALUES (?,?,?,?,?,'','',?)
ON CONFLICT(pr, block_id, unit_key) DO UPDATE SET
  code_hash = excluded.code_hash,
  status    = excluded.status,
  text      = '',
  model     = '',
  updated_at = excluded.updated_at`,
		e.PR, e.BlockID, e.UnitKey, e.CodeHash, StatusSearching, now())
	return err
}

// Save upserts one finished explanation (done or failed). WRITE —
// workflow-Activity-only.
func (m *Module) Save(ctx context.Context, e Entry) error {
	_, err := m.db.ExecContext(ctx, `
INSERT OR REPLACE INTO explanations (pr, block_id, unit_key, code_hash, status, text, model, updated_at)
VALUES (?,?,?,?,?,?,?,?)`,
		e.PR, e.BlockID, e.UnitKey, e.CodeHash, e.Status, e.Text, e.Model, now())
	return err
}

// List returns all explanations for a PR, ordered deterministically. READ —
// safe for the UI/API.
func (m *Module) List(ctx context.Context, pr int) ([]Entry, error) {
	rows, err := m.db.QueryContext(ctx, `
SELECT pr, block_id, unit_key, code_hash, status, text, model, updated_at
FROM explanations WHERE pr = ? ORDER BY block_id, unit_key`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.PR, &e.BlockID, &e.UnitKey, &e.CodeHash,
			&e.Status, &e.Text, &e.Model, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
