// Package prsnooze stores the reviewer's snoozed PRs for /pr-overview: "hide
// this PR until <moment>". One row per (repo, pr); snoozing again overwrites
// the row, un-snoozing deletes it.
//
// Its WRITE methods (Set/Clear) are driven only by the pr_snooze workflow's
// Activities (see .claude/rules/workflows-write-boundary.md); its READ method
// (List) backs the read-only GET /api/prsnoozes.
//
// The store deliberately records only the snooze itself: `until` (when it wakes
// up by itself) and `snoozed_at` (when it was set). Whether NEW ACTIVITY on the
// PR ends a snooze early is decided on the read side, by comparing snoozed_at
// against the PR's own GitHub updatedAt the inbox already carries — see
// "Snoozen" in .claude/docs/pr-overview.md for why that is not a write.
package prsnooze

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS pr_snoozes (
  repo       TEXT    NOT NULL,
  pr         INTEGER NOT NULL,
  until      TEXT    NOT NULL,
  snoozed_at TEXT    NOT NULL,
  PRIMARY KEY (repo, pr)
);
`

// Snooze is one stored snooze. Repo is the canonical repo string ("" for the
// primary repo, "owner/name" otherwise — see repos.go).
type Snooze struct {
	Repo      string    `json:"repo"`
	PR        int       `json:"pr"`
	Until     time.Time `json:"until"`
	SnoozedAt time.Time `json:"snoozedAt"`
}

// Module owns the snooze store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("prsnooze: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("prsnooze: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Set snoozes (repo, pr) until `until`, recorded as set at `at`. WRITE — call
// only from a workflow Activity. Idempotent (an upsert of the same values), so
// replay is safe. Also drops every snooze that had already expired at `at` —
// plain housekeeping so the table never grows without bound; an expired row is
// invisible to List anyway.
func (m *Module) Set(ctx context.Context, repo string, pr int, until, at time.Time) error {
	if _, err := m.db.ExecContext(ctx,
		`INSERT INTO pr_snoozes (repo, pr, until, snoozed_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(repo, pr) DO UPDATE SET until = excluded.until, snoozed_at = excluded.snoozed_at`,
		repo, pr, until.UTC().Format(time.RFC3339), at.UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	_, err := m.db.ExecContext(ctx, `DELETE FROM pr_snoozes WHERE until <= ?`, at.UTC().Format(time.RFC3339))
	return err
}

// Clear lifts the snooze on (repo, pr). WRITE — workflow Activity only.
// Idempotent: clearing a PR that is not snoozed is a no-op.
func (m *Module) Clear(ctx context.Context, repo string, pr int) error {
	_, err := m.db.ExecContext(ctx, `DELETE FROM pr_snoozes WHERE repo = ? AND pr = ?`, repo, pr)
	return err
}

// List returns every snooze still pending at `now` (until > now), across all
// repos, ordered by wake-up time. READ — safe from anywhere.
func (m *Module) List(ctx context.Context, now time.Time) ([]Snooze, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT repo, pr, until, snoozed_at FROM pr_snoozes WHERE until > ? ORDER BY until, repo, pr`,
		now.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Snooze{}
	for rows.Next() {
		var s Snooze
		var until, at string
		if err := rows.Scan(&s.Repo, &s.PR, &until, &at); err != nil {
			return nil, err
		}
		s.Until, _ = time.Parse(time.RFC3339, until)
		s.SnoozedAt, _ = time.Parse(time.RFC3339, at)
		out = append(out, s)
	}
	return out, rows.Err()
}
