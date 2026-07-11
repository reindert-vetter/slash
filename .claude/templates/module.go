// Package example is a module/service driven by workflow Activities. Write
// methods are workflow-only; read methods back the read-only UI. See
// .claude/rules/workflows-write-boundary.md and the skill add-module.
package example

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

// Item is one stored record.
type Item struct {
	ID        string `json:"id"`
	Body      string `json:"body"`
	CreatedAt string `json:"createdAt"`
}

// Module owns its storage/behaviour.
type Module struct{ db *sql.DB }

// Open opens (or creates) the module's own DB and applies its schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("example: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("example: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Save is a WRITE — call only from a workflow Activity. Idempotent so replay is
// safe.
func (m *Module) Save(ctx context.Context, it Item) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO items (id, body, created_at) VALUES (?,?,?)`,
		it.ID, it.Body, it.CreatedAt)
	return err
}

// List is a READ — safe for the UI/API.
func (m *Module) List(ctx context.Context) ([]Item, error) {
	rows, err := m.db.QueryContext(ctx, `SELECT id, body, created_at FROM items ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		var it Item
		if err := rows.Scan(&it.ID, &it.Body, &it.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}
