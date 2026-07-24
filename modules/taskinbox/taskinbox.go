// Package taskinbox is the task-inbox read-model module/service. It owns its
// own store (a SQLite table holding the latest aggregated "tasks" snapshot)
// and does its own thing with the data: nothing beyond storing/listing a
// wholesale-replaced list of derived tasks. A "task" here is not primarily
// stored anywhere else — it is derived by the task_inbox workflow's
// refreshTasks Activity (see buildTaskInbox in taskinbox_analysis.go) from
// three sources (PR review requests, unread comments on your own PRs, Jira
// tickets assigned to you) and simply persisted here so the UI never has to
// recompute it on every page load. Its WRITE method (Replace) is driven only
// by that Activity (per the project rule: only workflows mutate state); its
// READ method (List) backs the read-only UI. See
// .claude/rules/workflows-write-boundary.md and the skill add-module.
package taskinbox

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  subtitle    TEXT    NOT NULL DEFAULT '',
  points      INTEGER NOT NULL DEFAULT 0,
  point_notes TEXT    NOT NULL DEFAULT '[]',
  pr          INTEGER NOT NULL DEFAULT 0,
  url         TEXT    NOT NULL DEFAULT '',
  detail      TEXT    NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL DEFAULT 0
);
`

// Task is one derived, aggregated task in the inbox. PointNotes and Detail
// are opaque JSON (the main package owns their concrete shape per Kind) —
// this module never interprets them, only stores/returns them verbatim.
type Task struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"` // pr_review | comment_unread | jira
	Title      string `json:"title"`
	Subtitle   string `json:"subtitle,omitempty"`
	Points     int    `json:"points"`
	PointNotes string `json:"pointNotes"` // JSON array of {label, points}
	PR         int    `json:"pr,omitempty"`
	URL        string `json:"url,omitempty"`
	Detail     string `json:"detail,omitempty"` // JSON, kind-specific shape
	UpdatedAt  int64  `json:"updatedAt"`        // Unix-ms
}

// Module is the task-inbox read-model service.
type Module struct{ db *sql.DB }

// Open opens (or creates) the taskinbox DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("taskinbox: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("taskinbox: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Replace wholesale-swaps the stored task list: every call fully replaces the
// previous snapshot (mirrors relations.Replace/the inbox snapshot pattern) —
// tasks are derived, not incrementally maintained, so a partial update makes
// no sense. WRITE — workflow-driven only (the refreshTasks Activity).
func (m *Module) Replace(ctx context.Context, tasks []Task) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM tasks`); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO tasks (id, kind, title, subtitle, points, point_notes, pr, url, detail, updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, t := range tasks {
		notes := t.PointNotes
		if notes == "" {
			notes = "[]"
		}
		detail := t.Detail
		if detail == "" {
			detail = "{}"
		}
		if _, err := stmt.ExecContext(ctx,
			t.ID, t.Kind, t.Title, t.Subtitle, t.Points, notes, t.PR, t.URL, detail, t.UpdatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// List returns every stored task. READ — safe for the UI. Ordering (by
// points/recency) is deliberately left to a later stage (see the "Fase 3"
// note in the task-inbox design) — this simply returns whatever is stored,
// in insertion order.
func (m *Module) List(ctx context.Context) ([]Task, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT id, kind, title, subtitle, points, point_notes, pr, url, detail, updated_at FROM tasks`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		var t Task
		if err := rows.Scan(&t.ID, &t.Kind, &t.Title, &t.Subtitle, &t.Points, &t.PointNotes, &t.PR, &t.URL, &t.Detail, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
