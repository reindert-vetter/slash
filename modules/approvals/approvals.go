// Package approvals is the reviewer-approval module/service. It owns its own
// store (a SQLite read-model of the approved changed rows / call segments per
// block) and does its own thing with the data. Its WRITE method (Replace) is
// driven only by workflow activities (per the project rule: only workflows
// mutate state); its READ method (List) backs the read-only UI. See
// .claude/rules/workflows-write-boundary.md and the skill add-module.
//
// Approval is granular: not one block flag but the set of approved changed rows
// (row indices in the aligned diff) plus the approved call segments
// ("<row>:<segStart>" keys). Both live per block as JSON arrays, so a browser
// refresh restores exactly what the reviewer had ticked off.
package approvals

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS approvals (
  pr       INTEGER NOT NULL,
  block_id TEXT    NOT NULL,
  rows     TEXT    NOT NULL,
  calls    TEXT    NOT NULL,
  PRIMARY KEY (pr, block_id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_pr ON approvals(pr);
`

// Approval is the approved state of one block: the approved changed-row indices
// (Rows) and approved call segments (Calls, "<row>:<segStart>" keys).
type Approval struct {
	PR      int      `json:"pr"`
	BlockID string   `json:"blockId"`
	Rows    []int    `json:"rows"`
	Calls   []string `json:"calls"`
}

// Module owns the approvals store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the approvals DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("approvals: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("approvals: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("approvals: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Replace swaps in the full approval state for one block: it upserts the block's
// rows/calls, or deletes the block's row entirely when both are empty (nothing
// approved). WRITE — call only from a workflow Activity. Idempotent (re-applying
// the same set is a no-op), so replay is safe.
func (m *Module) Replace(ctx context.Context, pr int, blockID string, rows []int, calls []string) error {
	if len(rows) == 0 && len(calls) == 0 {
		_, err := m.db.ExecContext(ctx,
			`DELETE FROM approvals WHERE pr = ? AND block_id = ?`, pr, blockID)
		return err
	}
	if rows == nil {
		rows = []int{}
	}
	if calls == nil {
		calls = []string{}
	}
	rowsJSON, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	callsJSON, err := json.Marshal(calls)
	if err != nil {
		return err
	}
	_, err = m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO approvals (pr, block_id, rows, calls) VALUES (?,?,?,?)`,
		pr, blockID, string(rowsJSON), string(callsJSON))
	return err
}

// List returns every block's approval state for a PR, ordered deterministically.
// READ — safe for the UI/API.
func (m *Module) List(ctx context.Context, pr int) ([]Approval, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT pr, block_id, rows, calls FROM approvals WHERE pr = ? ORDER BY block_id`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Approval
	for rows.Next() {
		var (
			a                   Approval
			rowsJSON, callsJSON string
		)
		if err := rows.Scan(&a.PR, &a.BlockID, &rowsJSON, &callsJSON); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(rowsJSON), &a.Rows); err != nil {
			return nil, fmt.Errorf("approvals: decode rows: %w", err)
		}
		if err := json.Unmarshal([]byte(callsJSON), &a.Calls); err != nil {
			return nil, fmt.Errorf("approvals: decode calls: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
