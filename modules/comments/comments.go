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
  avatar_url     TEXT NOT NULL DEFAULT '',
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
  path           TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL DEFAULT '',
  github_id      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr);
CREATE INDEX IF NOT EXISTS idx_reactions_comment ON reactions(comment_id);
`

// Comment is a review comment on one line of code, with its reactions.
type Comment struct {
	ID     string `json:"id"`
	RunID  string `json:"runId"`
	PR     int    `json:"pr"`
	File   string `json:"file"`
	Line   int    `json:"line"`
	Author string `json:"author"`
	// AvatarURL is the author's GitHub profile picture, carried through from the
	// GitHub fetch for an imported comment (see github.ReviewComment.AvatarURL).
	// Empty for a comment placed in this app or by the AI risk check — the
	// frontend's avatarHTML then falls back to an initials circle.
	AvatarURL     string `json:"avatarUrl,omitempty"`
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
	Path string `json:"path,omitempty"`
	// Source is where the comment originated: "ui" (placed in this app, the
	// default) or "github" (imported from an existing GitHub review/PR comment).
	// The frontend badges GitHub-sourced comments; the workflow never re-posts a
	// github-sourced root back to GitHub (it already exists there).
	Source string `json:"source,omitempty"`
	// Kind classifies a comment's anchor: "" for a normal line/block comment
	// (has file:line), or "issue"/"review_summary" for a PR-wide comment with no
	// file:line anchor (shown in the PR-info column, not the block-scoped index).
	Kind string `json:"kind,omitempty"`
	// GithubID is the comment's own GitHub review-comment database id — set for
	// an imported comment (== the ImportedRootID) or, once known, for a
	// UI-placed comment that got posted to GitHub (the workflow's own
	// postResult.RootID, persisted after the fact via SetGithubID once that post
	// completes — see taskCodeCommentWorkflow in workflows.go). 0 means "not
	// (yet) known": a local/private note, a comment whose GitHub post hasn't
	// landed yet, or one that failed to post. The frontend uses this to build a
	// "#discussion_r<id>" deep link and to decide whether to show that option
	// at all (see focusedCommentGithubId in RelatedPanel.mjs).
	GithubID  int64      `json:"githubId,omitempty"`
	Reactions []Reaction `json:"reactions,omitempty"`
}

// Reaction is one reply/reaction hooked onto a comment.
type Reaction struct {
	ID        string `json:"id"`
	CommentID string `json:"commentId"`
	Source    string `json:"source"` // ui | github
	Author    string `json:"author"`
	// AvatarURL is the reply author's GitHub profile picture (see
	// Comment.AvatarURL) — empty for a reply written in this app.
	AvatarURL string `json:"avatarUrl,omitempty"`
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
		`ALTER TABLE comments ADD COLUMN source TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE comments ADD COLUMN github_id INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE comments ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE reactions ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''`,
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
		   (id, run_id, pr, file, line, author, avatar_url, body, created_at, reaction_count, status, code, gran, label, row_start, row_end, seg, path, source, kind, github_id)
		 VALUES (?,?,?,?,?,?,?,?,?,
		   COALESCE((SELECT reaction_count FROM comments WHERE id = ?), 0),
		   COALESCE((SELECT status FROM comments WHERE id = ?), ?),
		   ?,?,?,?,?,?,?,?,?,
		   COALESCE((SELECT github_id FROM comments WHERE id = ?), ?))`,
		c.ID, c.RunID, c.PR, c.File, c.Line, c.Author, c.AvatarURL, c.Body, c.CreatedAt, c.ID, c.ID, c.Status,
		c.Code, c.Gran, c.Label, c.RowStart, c.RowEnd, c.Seg, c.Path, c.Source, c.Kind, c.ID, c.GithubID)
	return err
}

// SetGithubID records the GitHub review-comment database id a comment's
// thread mirrors to, once it's known (either the ImportedRootID for an
// already-existing GitHub comment, or the id returned by posting a fresh one
// — see taskCodeCommentWorkflow in workflows.go). A no-op for id <= 0 (a
// local note, or a post that never happened/failed) — the column then simply
// stays at its zero-value default. WRITE — workflow-driven only.
func (m *Module) SetGithubID(ctx context.Context, id string, githubID int64) error {
	if githubID <= 0 {
		return nil
	}
	_, err := m.db.ExecContext(ctx, `UPDATE comments SET github_id = ? WHERE id = ?`, githubID, id)
	return err
}

// SetAvatarURL records the author's GitHub profile picture on an existing
// comment. Needed because a comment imported before the avatar was threaded
// through has an empty column and its Execution is never re-run (the import is
// idempotent on the gh-<id> Run ID), so the import glue backfills it through
// the workflow instead — see the "avatar" ReactionSignal action in
// workflows.go. A no-op for an empty url. WRITE — workflow-driven only.
func (m *Module) SetAvatarURL(ctx context.Context, id, url string) error {
	if url == "" {
		return nil
	}
	_, err := m.db.ExecContext(ctx, `UPDATE comments SET avatar_url = ? WHERE id = ?`, url, id)
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
		`INSERT OR IGNORE INTO reactions (id, comment_id, source, author, avatar_url, body, created_at)
		 VALUES (?,?,?,?,?,?,?)`,
		r.ID, r.CommentID, r.Source, r.Author, r.AvatarURL, r.Body, r.CreatedAt)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Already recorded — no double count. Do fill in the author's avatar if
		// this reply predates the avatar column (the reply poller re-signals every
		// GitHub reply after a restart, so this is where an old reply catches up).
		if r.AvatarURL != "" {
			if _, err := tx.ExecContext(ctx,
				`UPDATE reactions SET avatar_url = ? WHERE id = ? AND avatar_url = ''`,
				r.AvatarURL, r.ID); err != nil {
				return err
			}
		}
		return tx.Commit()
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

// Purge removes every comment (and, via ON DELETE CASCADE, its reactions) of
// pr — the same cascade Delete already relies on. WRITE — workflow-only, the
// per-PR data-retention cleanup path (see the cleanup workflow). Returns the
// number of comments removed, for logging.
func (m *Module) Purge(ctx context.Context, pr int) (int64, error) {
	res, err := m.db.ExecContext(ctx, `DELETE FROM comments WHERE pr = ?`, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
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
	q := `SELECT id, run_id, pr, file, line, author, avatar_url, body, created_at, reaction_count, status, code, gran, label, row_start, row_end, seg, path, source, kind, github_id
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
		if err := rows.Scan(&c.ID, &c.RunID, &c.PR, &c.File, &c.Line, &c.Author, &c.AvatarURL,
			&c.Body, &c.CreatedAt, &c.ReactionCount, &c.Status, &c.Code, &c.Gran, &c.Label,
			&c.RowStart, &c.RowEnd, &c.Seg, &c.Path, &c.Source, &c.Kind, &c.GithubID); err != nil {
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
		`SELECT id, comment_id, source, author, avatar_url, body, created_at FROM reactions ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rrows.Close()
	for rrows.Next() {
		var r Reaction
		if err := rrows.Scan(&r.ID, &r.CommentID, &r.Source, &r.Author, &r.AvatarURL, &r.Body, &r.CreatedAt); err != nil {
			return nil, err
		}
		if i, ok := byID[r.CommentID]; ok {
			out[i].Reactions = append(out[i].Reactions, r)
		}
	}
	return out, rrows.Err()
}
