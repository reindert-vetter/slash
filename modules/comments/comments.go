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

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS comments (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  repo           TEXT NOT NULL DEFAULT '',   -- canonical repo string: '' = the primary repo
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
  anchor_state   TEXT NOT NULL DEFAULT '',
  path           TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL DEFAULT '',
  github_id      INTEGER NOT NULL DEFAULT 0,
  block_wide     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  github_id  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr);
CREATE INDEX IF NOT EXISTS idx_reactions_comment ON reactions(comment_id);
`

// Comment is a review comment on one line of code, with its reactions.
type Comment struct {
	ID    string `json:"id"`
	RunID string `json:"runId"`
	// Repo is the canonical repo string of the PR this comment belongs to: ""
	// for the primary repo (so every row written before multi-repo existed is
	// already correct), "owner/name" for any other.
	Repo   string `json:"repo,omitempty"`
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
	// BlockWide marks a comment that is genuinely ABOUT the whole block (its
	// RowStart/RowEnd still point at one real row — the block's first changed
	// row, chosen only so the comment index/💬 marker have somewhere to hang —
	// but that row is a stand-in, not the actual subject). Set by
	// anchoredWarning (code_warning.go) for an LLM finding that pins to a
	// block but not to any one specific row (e.g. it's about a docblock
	// promise, not a changed line) — the frontend badges it "Geldt voor het
	// hele blok" instead of implying it's about that one row specifically.
	// False for every ordinary line/call comment.
	BlockWide bool `json:"blockWide,omitempty"`
	// AnchorState says how much the row anchor above can still be trusted after a
	// new commit re-scanned the block (see reanchor.go — the anchor is re-derived
	// from Code on every ingest refresh):
	//
	//   AnchorPinned ("")        the rows point at the code the comment is about.
	//   AnchorUnpinned           the block is still there but the anchored code
	//                            was edited away, so RowStart is -1 again: the
	//                            comment shows anywhere within its block and
	//                            claims no 💬 row (the pre-existing convention).
	//   AnchorOrphan             the symbol itself is gone from the PR (renamed,
	//                            deleted, file dropped). The rows are kept as a
	//                            record of where it WAS; the frontend surfaces
	//                            such a comment as its own index row so it isn't
	//                            silently lost.
	//
	// Deliberately separate from Kind: an orphan is still a block-scoped review
	// comment, and flipping its Kind to a PR-wide one would change how its replies
	// mirror to GitHub (see isPRWide in comment_import.go).
	AnchorState string `json:"anchorState,omitempty"`
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
	Source    string `json:"source"` // ui | github | ai (an automated reply, e.g. comment_autoresolve.go)
	Author    string `json:"author"`
	// AvatarURL is the reply author's GitHub profile picture (see
	// Comment.AvatarURL) — empty for a reply written in this app.
	AvatarURL string `json:"avatarUrl,omitempty"`
	Body      string `json:"body"`
	Resolves  bool   `json:"resolves"` // resolves the thread
	CreatedAt string `json:"createdAt"`
	// GithubID is this reply's own GitHub comment id, once known: set once the
	// UI reply is mirrored (a review-comment reply, or — for a PR-wide thread —
	// a new issue comment; see taskCodeCommentWorkflow's reactions loop in
	// workflows.go). 0 for a GitHub-sourced reply (never re-mirrored) or a
	// reply that failed to mirror/hasn't yet. Lets the reviewer's own later
	// edit of this reply PATCH the right GitHub comment.
	GithubID int64 `json:"githubId,omitempty"`
}

// Module is the comments service.
type Module struct{ db *sql.DB }

// Open opens (or creates) the comments DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
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
		`ALTER TABLE comments ADD COLUMN anchor_state TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE comments ADD COLUMN block_wide INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE reactions ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE reactions ADD COLUMN github_id INTEGER NOT NULL DEFAULT 0`,
		// Multi-repo (see repos.go): every pre-existing row belongs to the primary
		// repo, which IS the '' default — a pure ADD with no backfill.
		`ALTER TABLE comments ADD COLUMN repo TEXT NOT NULL DEFAULT ''`,
	} {
		_, _ = db.Exec(col) // ignore "duplicate column name"
	}
	// Only after the repo column is guaranteed to exist (see the schema note).
	_, _ = db.Exec(`CREATE INDEX IF NOT EXISTS idx_comments_pr_repo ON comments(repo, pr)`)
	// Index the path only after the column is guaranteed to exist (the ADD COLUMN
	// above runs first). Kept out of the main schema so applying it to an existing
	// DB — where the column is added here, not by CREATE TABLE — can't error.
	_, _ = db.Exec(`CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path)`)
}

// The AnchorState values a comment's row anchor can be in — see the field's own
// doc comment on Comment above.
const (
	AnchorPinned   = ""
	AnchorUnpinned = "unpinned"
	AnchorOrphan   = "orphan"
)

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
		   (id, run_id, repo, pr, file, line, author, avatar_url, body, created_at, reaction_count, status, code, gran, label, row_start, row_end, seg, anchor_state, path, source, kind, github_id, block_wide)
		 VALUES (?,?,?,?,?,?,?,?,?,?,
		   COALESCE((SELECT reaction_count FROM comments WHERE id = ?), 0),
		   COALESCE((SELECT status FROM comments WHERE id = ?), ?),
		   ?,?,?,?,?,?,?,?,?,?,
		   COALESCE((SELECT github_id FROM comments WHERE id = ?), ?),?)`,
		c.ID, c.RunID, c.Repo, c.PR, c.File, c.Line, c.Author, c.AvatarURL, c.Body, c.CreatedAt, c.ID, c.ID, c.Status,
		c.Code, c.Gran, c.Label, c.RowStart, c.RowEnd, c.Seg, c.AnchorState, c.Path, c.Source, c.Kind, c.ID, c.GithubID, c.BlockWide)
	return err
}

// SetAnchor moves a comment's row anchor (and the codeRef segment of its
// hierarchical Path, which encodes the same rows — otherwise a prefix Search would
// drift out of sync with the anchor it addresses) and records how much that anchor
// can still be trusted. Called once per changed anchor after an ingest refresh
// re-scanned the block; the new values are computed by reanchor.go and delivered as
// a Signal to the comment's own Execution, so the move lands in that comment's
// replayable history like every other change to it.
//
// Gran rides along because a 'call' anchor degrades to 'line' when its character
// offsets no longer apply. Code is deliberately NOT touched: the stored snippet is
// what the comment is about and what the matcher searches for next time.
// WRITE — workflow-driven only.
func (m *Module) SetAnchor(ctx context.Context, id string, rowStart, rowEnd int, seg, gran, anchorState, path string) error {
	_, err := m.db.ExecContext(ctx,
		`UPDATE comments SET row_start = ?, row_end = ?, seg = ?, gran = ?, anchor_state = ?, path = ? WHERE id = ?`,
		rowStart, rowEnd, seg, gran, anchorState, path, id)
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

// UpdateBody overwrites a comment's own body — the reviewer editing an
// already-placed comment they wrote themselves. Leaves every other column
// (status, anchor, code snippet, github_id) untouched. WRITE — workflow-driven
// only.
func (m *Module) UpdateBody(ctx context.Context, id, body string) error {
	_, err := m.db.ExecContext(ctx, `UPDATE comments SET body = ? WHERE id = ?`, body, id)
	return err
}

// UpdateReactionBody overwrites one reply's own body — the reviewer editing a
// reply they wrote earlier in the thread. WRITE — workflow-driven only.
func (m *Module) UpdateReactionBody(ctx context.Context, id, body string) error {
	_, err := m.db.ExecContext(ctx, `UPDATE reactions SET body = ? WHERE id = ?`, body, id)
	return err
}

// SetReactionGithubID records the GitHub comment id a reply was mirrored to,
// once known — see Reaction.GithubID. A no-op for id <= 0, mirroring
// SetGithubID's own convention for the root comment. WRITE — workflow-driven
// only.
func (m *Module) SetReactionGithubID(ctx context.Context, id string, githubID int64) error {
	if githubID <= 0 {
		return nil
	}
	_, err := m.db.ExecContext(ctx, `UPDATE reactions SET github_id = ? WHERE id = ?`, githubID, id)
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
func (m *Module) Purge(ctx context.Context, repo string, pr int) (int64, error) {
	res, err := m.db.ExecContext(ctx, `DELETE FROM comments WHERE repo = ? AND pr = ?`, repo, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Get returns the single comment matching id, with its reactions. The second
// return value is false when no such comment exists (never an error in that
// case) — READ, safe for the UI and for a workflow Activity that needs to
// validate a comment before acting on it (see applyChatCommentAction in
// chat_workflow.go, "claude_chat"'s opt-in influence on a comment thread).
func (m *Module) Get(ctx context.Context, id string) (Comment, bool, error) {
	list, err := m.query(ctx, `WHERE id = ?`, id)
	if err != nil {
		return Comment{}, false, err
	}
	if len(list) == 0 {
		return Comment{}, false, nil
	}
	return list[0], true, nil
}

// List returns the comments of one PR (or every PR of every repo if pr <= 0),
// each with its reactions. READ — safe for the UI.
func (m *Module) List(ctx context.Context, repo string, pr int) ([]Comment, error) {
	if pr > 0 {
		return m.query(ctx, `WHERE repo = ? AND pr = ?`, repo, pr)
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
	q := `SELECT id, run_id, repo, pr, file, line, author, avatar_url, body, created_at, reaction_count, status, code, gran, label, row_start, row_end, seg, anchor_state, path, source, kind, github_id, block_wide
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
		if err := rows.Scan(&c.ID, &c.RunID, &c.Repo, &c.PR, &c.File, &c.Line, &c.Author, &c.AvatarURL,
			&c.Body, &c.CreatedAt, &c.ReactionCount, &c.Status, &c.Code, &c.Gran, &c.Label,
			&c.RowStart, &c.RowEnd, &c.Seg, &c.AnchorState, &c.Path, &c.Source, &c.Kind, &c.GithubID, &c.BlockWide); err != nil {
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
		`SELECT id, comment_id, source, author, avatar_url, body, created_at, github_id FROM reactions ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rrows.Close()
	for rrows.Next() {
		var r Reaction
		if err := rrows.Scan(&r.ID, &r.CommentID, &r.Source, &r.Author, &r.AvatarURL, &r.Body, &r.CreatedAt, &r.GithubID); err != nil {
			return nil, err
		}
		if i, ok := byID[r.CommentID]; ok {
			out[i].Reactions = append(out[i].Reactions, r)
		}
	}
	return out, rrows.Err()
}
