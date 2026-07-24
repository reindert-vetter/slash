// Package reviewerusage is a small local usage-store module: it counts, per
// (repo, reviewer login), how often the reviewer has been assigned to a PR
// through the "Ready for review" flow (see the ready_for_review workflow). The
// PR overview uses those counts to sort the collaborator picker most-used-first.
//
// Its WRITE method (Bump) is driven only by a workflow Activity (per the
// project rule: only workflows mutate state); its READ method (List) backs the
// read-only /api/reviewers endpoint. See .claude/rules/workflows-write-boundary.md
// and the skill add-module.
//
// The count is deliberately "personal": nothing else writes to it, so it only
// ever reflects the reviewers this app's user assigned through this feature —
// not repo-wide review activity.
package reviewerusage

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS reviewer_usage (
  repo  TEXT    NOT NULL,
  login TEXT    NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, login)
);

CREATE INDEX IF NOT EXISTS idx_reviewer_usage_repo ON reviewer_usage(repo);
`

// Usage is one reviewer's assignment count for a repo.
type Usage struct {
	Login string `json:"login"`
	Count int    `json:"count"`
}

// Module owns the reviewer-usage store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the reviewer-usage DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("reviewerusage: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("reviewerusage: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("reviewerusage: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Bump increments the usage count of each login by one for repo (inserting a
// row at 1 the first time). WRITE — call only from a workflow Activity. Empty
// logins are skipped; duplicate logins in one call are collapsed so a reviewer
// counts at most once per assignment.
func (m *Module) Bump(ctx context.Context, repo string, logins []string) error {
	seen := map[string]bool{}
	for _, login := range logins {
		if login == "" || seen[login] {
			continue
		}
		seen[login] = true
		if _, err := m.db.ExecContext(ctx,
			`INSERT INTO reviewer_usage (repo, login, count) VALUES (?,?,1)
			 ON CONFLICT(repo, login) DO UPDATE SET count = count + 1`,
			repo, login); err != nil {
			return err
		}
	}
	return nil
}

// List returns every reviewer's usage count for a repo, most-used first (ties
// broken alphabetically for a stable order). READ — safe for the UI/API.
func (m *Module) List(ctx context.Context, repo string) ([]Usage, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT login, count FROM reviewer_usage WHERE repo = ? ORDER BY count DESC, login ASC`, repo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Usage
	for rows.Next() {
		var u Usage
		if err := rows.Scan(&u.Login, &u.Count); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
