// Package comments is the comments module/service. It owns its own store (a
// SQLite read-model of comments + reactions) and does its own thing with the
// data: it derives a reaction count and a thread status. Its WRITE methods are
// driven only by workflow activities (per the project rule: only workflows
// mutate state); its READ methods back the read-only UI.
package comments

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS comments (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  pr             INTEGER NOT NULL,
  file           TEXT NOT NULL,
  line           INTEGER NOT NULL,
  author         TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr);
CREATE INDEX IF NOT EXISTS idx_reactions_comment ON reactions(comment_id);
`

// Comment is a review comment on one line of code, with its reactions.
type Comment struct {
	ID            string     `json:"id"`
	RunID         string     `json:"runId"`
	PR            int        `json:"pr"`
	File          string     `json:"file"`
	Line          int        `json:"line"`
	Author        string     `json:"author"`
	Body          string     `json:"body"`
	CreatedAt     string     `json:"createdAt"`
	ReactionCount int        `json:"reactionCount"`
	Status        string     `json:"status"` // open | resolved
	Reactions     []Reaction `json:"reactions,omitempty"`
}

// Reaction is one reply/reaction hooked onto a comment.
type Reaction struct {
	ID        string `json:"id"`
	CommentID string `json:"commentId"`
	Source    string `json:"source"` // ui | github
	Author    string `json:"author"`
	Body      string `json:"body"`
	Resolves  bool   `json:"resolves"` // resolves the thread
	CreatedAt string `json:"createdAt"`
}

// Module is the comments service.
type Module struct{ db *sql.DB }

// Open opens (or creates) the comments DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("comments: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("comments: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("comments: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

const ts = time.RFC3339Nano

// Save persists a comment (idempotent on ID). WRITE — workflow-driven only.
func (m *Module) Save(ctx context.Context, c Comment) error {
	if c.CreatedAt == "" {
		c.CreatedAt = time.Now().Format(ts)
	}
	if c.Status == "" {
		c.Status = "open"
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO comments
		   (id, run_id, pr, file, line, author, body, created_at, reaction_count, status)
		 VALUES (?,?,?,?,?,?,?,?,
		   COALESCE((SELECT reaction_count FROM comments WHERE id = ?), 0),
		   COALESCE((SELECT status FROM comments WHERE id = ?), ?))`,
		c.ID, c.RunID, c.PR, c.File, c.Line, c.Author, c.Body, c.CreatedAt, c.ID, c.ID, c.Status)
	return err
}

// AddReaction stores a reaction and does the module's own thing: it bumps the
// comment's reaction_count and resolves the thread when a reaction says so.
// WRITE — workflow-driven only. Idempotent on reaction ID.
func (m *Module) AddReaction(ctx context.Context, r Reaction) error {
	if r.CreatedAt == "" {
		r.CreatedAt = time.Now().Format(ts)
	}
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO reactions (id, comment_id, source, author, body, created_at)
		 VALUES (?,?,?,?,?,?)`,
		r.ID, r.CommentID, r.Source, r.Author, r.Body, r.CreatedAt)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return tx.Commit() // already recorded — no double count
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE comments SET reaction_count = reaction_count + 1 WHERE id = ?`, r.CommentID); err != nil {
		return err
	}
	if r.Resolves || strings.Contains(strings.ToLower(r.Body), "/resolve") {
		if _, err := tx.ExecContext(ctx,
			`UPDATE comments SET status = 'resolved' WHERE id = ?`, r.CommentID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// List returns the comments of one PR (or all PRs if pr <= 0), each with its
// reactions. READ — safe for the UI.
func (m *Module) List(ctx context.Context, pr int) ([]Comment, error) {
	q := `SELECT id, run_id, pr, file, line, author, body, created_at, reaction_count, status
	      FROM comments`
	var args []any
	if pr > 0 {
		q += ` WHERE pr = ?`
		args = append(args, pr)
	}
	q += ` ORDER BY created_at`
	rows, err := m.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Comment
	byID := map[string]int{}
	for rows.Next() {
		var c Comment
		if err := rows.Scan(&c.ID, &c.RunID, &c.PR, &c.File, &c.Line, &c.Author,
			&c.Body, &c.CreatedAt, &c.ReactionCount, &c.Status); err != nil {
			return nil, err
		}
		byID[c.ID] = len(out)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}

	rrows, err := m.db.QueryContext(ctx,
		`SELECT id, comment_id, source, author, body, created_at FROM reactions ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rrows.Close()
	for rrows.Next() {
		var r Reaction
		if err := rrows.Scan(&r.ID, &r.CommentID, &r.Source, &r.Author, &r.Body, &r.CreatedAt); err != nil {
			return nil, err
		}
		if i, ok := byID[r.CommentID]; ok {
			out[i].Reactions = append(out[i].Reactions, r)
		}
	}
	return out, rrows.Err()
}
