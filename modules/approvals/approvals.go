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
//
// A row index alone is meaningless once the PR gets new commits, so every
// approved row ALSO stores the code it pointed at (Anchors: the row's own
// displayed text plus its immediate neighbours). That is what lets reanchor.go
// find the row again after the file shifted — see its doc comment.
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

// RowAnchor is the code one approved row pointed at when it was approved: its
// own displayed text plus the text of the rows immediately above and below it
// (empty at the block's edges). Stored verbatim; the matcher normalizes
// whitespace when it compares. The neighbours are what disambiguate a repeated
// line (a bare `}`, a mirrored array literal) from its twins — the reviewer's
// own suggestion, and the same rule contextRemap already applies.
type RowAnchor struct {
	Row  int    `json:"row"`
	Text string `json:"text"`
	Prev string `json:"prev"`
	Next string `json:"next"`
}

// Approval is the approved state of one block: the approved changed-row indices
// (Rows), the approved call segments (Calls, "<row>:<segStart>" keys) and the
// per-row code anchors (Anchors) that survive a shift of the file.
type Approval struct {
	PR      int         `json:"pr"`
	BlockID string      `json:"blockId"`
	Rows    []int       `json:"rows"`
	Calls   []string    `json:"calls"`
	Anchors []RowAnchor `json:"anchors,omitempty"`
}

// Module owns the approvals store.
type Module struct{ db *sql.DB }

// migrate adds the columns introduced after the first release. Light
// ALTER TABLE, ignoring the "duplicate column" error, same shape as the
// avatar_url migration in modules/comments.
func migrate(db *sql.DB) {
	_, _ = db.Exec(`ALTER TABLE approvals ADD COLUMN anchors TEXT NOT NULL DEFAULT '[]'`)
}

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
	migrate(db)
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("approvals: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Replace swaps in the full approval state for one block: it upserts the block's
// rows/calls, or deletes the block's row entirely when both are empty (nothing
// approved). WRITE — call only from a workflow Activity. Idempotent (re-applying
// the same set is a no-op), so replay is safe.
func (m *Module) Replace(ctx context.Context, pr int, blockID string, rows []int, calls []string, anchors []RowAnchor) error {
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
	// nil (the field absent from the caller's payload) means "leave the stored
	// anchors alone" — a caller that only trims an existing set, or one that
	// couldn't describe the rows because the block's code wasn't loaded, must
	// not silently erase them. An explicitly EMPTY slice does clear them.
	if anchors == nil {
		var existing string
		err := m.db.QueryRowContext(ctx,
			`SELECT anchors FROM approvals WHERE pr = ? AND block_id = ?`, pr, blockID).Scan(&existing)
		if err == nil && existing != "" {
			_ = json.Unmarshal([]byte(existing), &anchors)
		}
		if anchors == nil {
			anchors = []RowAnchor{}
		}
	}
	anchorsJSON, err := json.Marshal(anchors)
	if err != nil {
		return err
	}
	_, err = m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO approvals (pr, block_id, rows, calls, anchors) VALUES (?,?,?,?,?)`,
		pr, blockID, string(rowsJSON), string(callsJSON), string(anchorsJSON))
	return err
}

// Purge removes every approval row of pr. WRITE — workflow-only, the per-PR
// data-retention cleanup path (see the cleanup workflow). Returns the number
// of rows removed, for logging.
func (m *Module) Purge(ctx context.Context, pr int) (int64, error) {
	res, err := m.db.ExecContext(ctx, `DELETE FROM approvals WHERE pr = ?`, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// List returns every block's approval state for a PR, ordered deterministically.
// READ — safe for the UI/API.
func (m *Module) List(ctx context.Context, pr int) ([]Approval, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT pr, block_id, rows, calls, anchors FROM approvals WHERE pr = ? ORDER BY block_id`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Approval
	for rows.Next() {
		var (
			a                                Approval
			rowsJSON, callsJSON, anchorsJSON string
		)
		if err := rows.Scan(&a.PR, &a.BlockID, &rowsJSON, &callsJSON, &anchorsJSON); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(rowsJSON), &a.Rows); err != nil {
			return nil, fmt.Errorf("approvals: decode rows: %w", err)
		}
		if err := json.Unmarshal([]byte(callsJSON), &a.Calls); err != nil {
			return nil, fmt.Errorf("approvals: decode calls: %w", err)
		}
		if anchorsJSON != "" {
			if err := json.Unmarshal([]byte(anchorsJSON), &a.Anchors); err != nil {
				return nil, fmt.Errorf("approvals: decode anchors: %w", err)
			}
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
