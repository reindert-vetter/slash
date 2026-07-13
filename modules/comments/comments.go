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
  status         TEXT NOT NULL DEFAULT 'open',
  code           TEXT NOT NULL DEFAULT '',
  gran           TEXT NOT NULL DEFAULT '',
  label          TEXT NOT NULL DEFAULT '',
  row_start      INTEGER NOT NULL DEFAULT -1,
  row_end        INTEGER NOT NULL DEFAULT -1,
  seg            TEXT NOT NULL DEFAULT '',
  path           TEXT NOT NULL DEFAULT ''
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
	ID            string `json:"id"`
	RunID         string `json:"runId"`
	PR            int    `json:"pr"`
	File          string `json:"file"`
	Line          int    `json:"line"`
	Author        string `json:"author"`
	Body          string `json:"body"`
	CreatedAt     string `json:"createdAt"`
	ReactionCount int    `json:"reactionCount"`
	Status        string `json:"status"` // open | resolved
	// Code is the source snippet the comment is attached to (the exact
	// navigation unit at placement time), with Gran/Label describing it —
	// so the thread can show what the comment is about, like the composer does.
	Code  string `json:"code,omitempty"`
	Gran  string `json:"gran,omitempty"`
	Label string `json:"label,omitempty"`
	// RowStart/RowEnd/Seg pin the comment to its exact navigation unit within the
	// block's aligned diff rows, so the comment index can be filtered to the units
	// under the current selection (call ⊂ line ⊂ group ⊂ block). RowStart/RowEnd
	// are inclusive row indices into blockRows; Seg identifies the one call
	// segment for a 'call'-granularity comment (empty otherwise). RowStart < 0
	// means "unknown" (legacy/seeded comment) — always shown within its block.
	RowStart int    `json:"rowStart"`
	RowEnd   int    `json:"rowEnd"`
	Seg      string `json:"seg,omitempty"`
	// Path is the hierarchical address the comment hangs on, from PR down to the
	// exact code reference:  /pr-<pr>/<file>/<label>/<codeRef>/comment-<id>. It's
	// built by the workflow (deterministic from the input + Run ID, see
	// commentPath in workflows.go) and indexed, so a prefix match finds every
	// comment under a scope: /pr-123 (whole PR), /pr-123/<file> (one file),
	// …/<label> (one block), …/<codeRef> (one navigation unit).
	Path      string     `json:"path,omitempty"`
	Reactions []Reaction `json:"reactions,omitempty"`
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
	migrate(db)
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("comments: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

// migrate adds columns introduced after the first schema so an existing
// comments.db picks them up. CREATE TABLE IF NOT EXISTS never alters an
// existing table, so the code/gran/label columns need explicit ADDs; a
// duplicate-column error just means the DB is already up to date.
func migrate(db *sql.DB) {
	for _, col := range []string{
		`ALTER TABLE comments ADD COLUMN code TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE comments ADD COLUMN gran TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE comments ADD COLUMN label TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE comments ADD COLUMN row_start INTEGER NOT NULL DEFAULT -1`,
		`ALTER TABLE comments ADD COLUMN row_end INTEGER NOT NULL DEFAULT -1`,
		`ALTER TABLE comments ADD COLUMN seg TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE comments ADD COLUMN path TEXT NOT NULL DEFAULT ''`,
	} {
		_, _ = db.Exec(col) // ignore "duplicate column name"
	}
	// Index the path only after the column is guaranteed to exist (the ADD COLUMN
	// above runs first). Kept out of the main schema so applying it to an existing
	// DB — where the column is added here, not by CREATE TABLE — can't error.
	_, _ = db.Exec(`CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path)`)
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
		   (id, run_id, pr, file, line, author, body, created_at, reaction_count, status, code, gran, label, row_start, row_end, seg, path)
		 VALUES (?,?,?,?,?,?,?,?,
		   COALESCE((SELECT reaction_count FROM comments WHERE id = ?), 0),
		   COALESCE((SELECT status FROM comments WHERE id = ?), ?),
		   ?,?,?,?,?,?,?)`,
		c.ID, c.RunID, c.PR, c.File, c.Line, c.Author, c.Body, c.CreatedAt, c.ID, c.ID, c.Status,
		c.Code, c.Gran, c.Label, c.RowStart, c.RowEnd, c.Seg, c.Path)
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

// SetStatus updates a comment's status directly (e.g. to "deleting", the
// transient state shown while a delete is in flight before the row is
// actually removed). WRITE — workflow-driven only.
func (m *Module) SetStatus(ctx context.Context, id, status string) error {
	_, err := m.db.ExecContext(ctx, `UPDATE comments SET status = ? WHERE id = ?`, status, id)
	return err
}

// Delete removes a comment and its reactions (ON DELETE CASCADE). WRITE —
// workflow-driven only, the final step of the delete flow (see SetStatus).
func (m *Module) Delete(ctx context.Context, id string) error {
	_, err := m.db.ExecContext(ctx, `DELETE FROM comments WHERE id = ?`, id)
	return err
}

// List returns the comments of one PR (or all PRs if pr <= 0), each with its
// reactions. READ — safe for the UI.
func (m *Module) List(ctx context.Context, pr int) ([]Comment, error) {
	if pr > 0 {
		return m.query(ctx, `WHERE pr = ?`, pr)
	}
	return m.query(ctx, ``)
}

// Search returns every comment whose Path starts with prefix, each with its
// reactions — a prefix match over the hierarchical address, so "/pr-123" finds
// the whole PR, "/pr-123/app/Foo.php" one file, and so on. An empty prefix
// returns everything. READ — safe for the UI.
func (m *Module) Search(ctx context.Context, prefix string) ([]Comment, error) {
	if prefix == "" {
		return m.query(ctx, ``)
	}
	// Escape LIKE wildcards in the prefix so it matches literally, then append %.
	esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(prefix)
	return m.query(ctx, `WHERE path LIKE ? ESCAPE '\'`, esc+"%")
}

// query runs the comment select with an optional WHERE clause + args and
// attaches each comment's reactions. Shared by List and Search.
func (m *Module) query(ctx context.Context, where string, args ...any) ([]Comment, error) {
	q := `SELECT id, run_id, pr, file, line, author, body, created_at, reaction_count, status, code, gran, label, row_start, row_end, seg, path
	      FROM comments`
	if where != "" {
		q += ` ` + where
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
			&c.Body, &c.CreatedAt, &c.ReactionCount, &c.Status, &c.Code, &c.Gran, &c.Label,
			&c.RowStart, &c.RowEnd, &c.Seg, &c.Path); err != nil {
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
