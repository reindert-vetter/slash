// Package relations is the block-relations module/service. It owns its own store
// (a SQLite read-model of many-to-many edges between blocks) and does its own
// thing with the data. Its WRITE method (Replace) is driven only by workflow
// activities (per the project rule: only workflows mutate state); its READ
// method (List) backs the read-only UI. See
// .claude/rules/workflows-write-boundary.md and the skill add-module.
//
// A relation couples a parent block to a child block under a kind (the first
// kind is "event_listener": a block that dispatches an event → the changed
// Listener::handle for that event). The kind column keeps the store open for
// more relation types later without touching the schema.
package relations

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS relations (
  pr        INTEGER NOT NULL,
  parent_id TEXT    NOT NULL,
  child_id  TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  PRIMARY KEY (pr, parent_id, child_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_relations_pr ON relations(pr);
`

// Kind values (extend as more relation types are added).
const KindEventListener = "event_listener"

// Relation is one directed parent→child edge between two blocks (by block ID,
// i.e. "<pr>:<file>:<symbol>"), tagged with its kind.
type Relation struct {
	PR       int    `json:"pr"`
	ParentID string `json:"parentId"`
	ChildID  string `json:"childId"`
	Kind     string `json:"kind"`
}

// Module owns the relations store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the relations DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("relations: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("relations: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("relations: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Replace swaps in the full relation set for one PR: it deletes the PR's rows
// and re-inserts rels in a single transaction. WRITE — call only from a
// workflow Activity. Idempotent (a re-run with the same rels is a no-op), so
// replay is safe and re-ingest just rebuilds.
func (m *Module) Replace(ctx context.Context, pr int, rels []Relation) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM relations WHERE pr = ?`, pr); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx,
		`INSERT OR IGNORE INTO relations (pr, parent_id, child_id, kind) VALUES (?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range rels {
		if _, err := stmt.ExecContext(ctx, pr, r.ParentID, r.ChildID, r.Kind); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// List returns all relations for a PR, ordered deterministically. READ — safe
// for the UI/API.
func (m *Module) List(ctx context.Context, pr int) ([]Relation, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT pr, parent_id, child_id, kind FROM relations WHERE pr = ? ORDER BY parent_id, child_id, kind`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Relation
	for rows.Next() {
		var r Relation
		if err := rows.Scan(&r.PR, &r.ParentID, &r.ChildID, &r.Kind); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
