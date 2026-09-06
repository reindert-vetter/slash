// Package plan is the read-model behind the /plan/<JIRA-KEY> planning page:
// one PLAN DOCUMENT per Jira issue — the ticket itself, the clarifying
// questions Claude asks to sharpen the plan (each with its own answer options
// and example-code blocks), the answers the reviewer picked, and the resulting
// "what has to be done" task list.
//
// The document is stored as ONE JSON blob per issue key rather than as a
// normalised question/option/block schema: it is written and read as a whole
// (one LLM answer in, one page render out), nothing ever queries across
// documents, and the nesting of the example blocks is arbitrarily deep — a
// table per level would buy nothing here. See .claude/docs/plan-page.md.
//
// Its WRITE method (Save) is driven only by a workflow Activity (per the
// project rule: only workflows mutate state); its READ method (Get) backs the
// read-only GET /api/plan. See .claude/rules/workflows-write-boundary.md.
package plan

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS plans (
  key        TEXT NOT NULL PRIMARY KEY,
  doc        TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

// Module owns the plan-document store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the plan DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("plan: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("plan: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("plan: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Get returns the stored plan document for key (raw JSON), or ok=false when
// nothing was ever written for it. READ — safe from anywhere.
func (m *Module) Get(ctx context.Context, key string) (string, bool, error) {
	var doc string
	err := m.db.QueryRowContext(ctx, `SELECT doc FROM plans WHERE key = ?`, key).Scan(&doc)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return doc, true, nil
}

// Save persists the whole plan document for key. WRITE — call only from a
// workflow Activity. Idempotent (re-applying the same document is a no-op), so
// replay is safe.
func (m *Module) Save(ctx context.Context, key, doc, updatedAt string) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO plans (key, doc, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
		key, doc, updatedAt)
	return err
}
