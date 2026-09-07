// Package jiranotify is the read-model for the reviewer's Jira notification
// feed (the bell menu, see modules/jira/notifications.go). It owns a tiny
// SQLite table: one row per notification, carrying both what the feed said
// (feed_unread) and what THIS app knows (read_at — set when the reviewer opened
// the row here).
//
// Its WRITE methods (Upsert/MarkRead/MarkUnread/Purge) are driven only by the jira_inbox
// and cleanup workflows' Activities, per the project rule that only workflows
// mutate state; its READ method (List) backs the read-only GET
// /api/jira/notifications.
//
// Why a local read_at at all, given the feed reports its own read state: this
// app never marks anything read in Jira (that would be a write into an
// undocumented endpoint on the reviewer's behalf), so without it every row the
// reviewer opened here would come back unread on the very next poll.
package jiranotify

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

CREATE TABLE IF NOT EXISTS jira_notifications (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  issue_key   TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT '',
  avatar_url  TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  feed_unread INTEGER NOT NULL DEFAULT 1,
  read_at     TEXT NOT NULL DEFAULT ''
);
`

// migrate adds the columns introduced after the first release: the richer
// per-notification detail (issue summary/status/type-icon, the "+N updates
// from X" grouping note, a comment preview) a reviewer asked for after
// comparing this feed side-by-side with Jira's own bell panel. Light
// ALTER TABLE, ignoring the "duplicate column" error, same shape as the
// avatar_url migration in modules/comments.
func migrate(db *sql.DB) {
	_, _ = db.Exec(`ALTER TABLE jira_notifications ADD COLUMN issue_title TEXT NOT NULL DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE jira_notifications ADD COLUMN issue_status TEXT NOT NULL DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE jira_notifications ADD COLUMN issue_icon_url TEXT NOT NULL DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE jira_notifications ADD COLUMN group_size INTEGER NOT NULL DEFAULT 1`)
	_, _ = db.Exec(`ALTER TABLE jira_notifications ADD COLUMN other_actor TEXT NOT NULL DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE jira_notifications ADD COLUMN comment_preview TEXT NOT NULL DEFAULT ''`)
	// forced_unread backs "mark as unread" (the right-click action on a
	// notification row, see .claude/docs/pr-overview.md). A local override
	// like read_at, and for the same reason: this app never writes into Jira,
	// so the feed keeps reporting its own read state and the next Upsert would
	// otherwise flip the row straight back to read.
	_, _ = db.Exec(`ALTER TABLE jira_notifications ADD COLUMN forced_unread INTEGER NOT NULL DEFAULT 0`)
}

// Item is one stored notification. Unread is the effective state the UI
// filters on: the reviewer explicitly marked it unread here, OR the feed still
// calls it unread AND the reviewer never opened it here. IssueTitle/IssueStatus/IssueIconURL/GroupSize/OtherActor/
// CommentPreview mirror jira.Notification's own fields of the same name — see
// that struct's doc comment for what each backs on screen.
type Item struct {
	ID             string `json:"id"`
	At             string `json:"at"`
	Title          string `json:"title"`
	IssueKey       string `json:"issueKey"`
	Actor          string `json:"actor"`
	AvatarURL      string `json:"avatarUrl"`
	URL            string `json:"url"`
	Unread         bool   `json:"unread"`
	IssueTitle     string `json:"issueTitle,omitempty"`
	IssueStatus    string `json:"issueStatus,omitempty"`
	IssueIconURL   string `json:"issueIconUrl,omitempty"`
	GroupSize      int    `json:"groupSize"`
	OtherActor     string `json:"otherActor,omitempty"`
	CommentPreview string `json:"commentPreview,omitempty"`
}

// Module is the notification read-model service.
type Module struct{ db *sql.DB }

// Open opens (or creates) the DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("jiranotify: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("jiranotify: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Upsert stores the fetched feed. An existing row keeps its read_at AND its
// forced_unread — the whole point of those two local columns — while every
// other field is refreshed from the feed. WRITE — workflow-driven only.
func (m *Module) Upsert(ctx context.Context, items []Item) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, it := range items {
		if it.ID == "" {
			continue
		}
		unread := 0
		if it.Unread {
			unread = 1
		}
		if it.GroupSize < 1 {
			it.GroupSize = 1 // never store 0 — see jira.Notification's own doc comment
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO jira_notifications
			   (id, at, title, issue_key, actor, avatar_url, url, feed_unread, read_at,
			    issue_title, issue_status, issue_icon_url, group_size, other_actor, comment_preview,
			    forced_unread)
			 VALUES (?,?,?,?,?,?,?,?,'',?,?,?,?,?,?,0)
			 ON CONFLICT(id) DO UPDATE SET
			   at=excluded.at, title=excluded.title, issue_key=excluded.issue_key,
			   actor=excluded.actor, avatar_url=excluded.avatar_url, url=excluded.url,
			   feed_unread=excluded.feed_unread,
			   issue_title=excluded.issue_title, issue_status=excluded.issue_status,
			   issue_icon_url=excluded.issue_icon_url, group_size=excluded.group_size,
			   other_actor=excluded.other_actor, comment_preview=excluded.comment_preview`,
			it.ID, it.At, it.Title, it.IssueKey, it.Actor, it.AvatarURL, it.URL, unread,
			it.IssueTitle, it.IssueStatus, it.IssueIconURL, it.GroupSize, it.OtherActor, it.CommentPreview); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// MarkRead records that the reviewer opened this notification here. Marking an
// unknown id is not an error (the row may have been purged) — idempotent, so
// replaying the Activity is safe. WRITE — workflow-driven only.
func (m *Module) MarkRead(ctx context.Context, id, at string) error {
	if id == "" {
		return nil
	}
	if at == "" {
		at = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := m.db.ExecContext(ctx,
		`UPDATE jira_notifications SET read_at = ?, forced_unread = 0 WHERE id = ? AND read_at = ''`, at, id)
	return err
}

// MarkUnread is MarkRead's mirror: the reviewer marked this notification
// unread again here (the right-click action on a notification row). It clears
// the local read_at AND raises forced_unread, because the feed itself may well
// call the row read — this app never writes into Jira, so without the override
// the very next Upsert would silently undo it. Marking an unknown id is not an
// error, and re-running is a no-op, so replaying the Activity is safe.
// WRITE — workflow-driven only.
func (m *Module) MarkUnread(ctx context.Context, id string) error {
	if id == "" {
		return nil
	}
	_, err := m.db.ExecContext(ctx,
		`UPDATE jira_notifications SET read_at = '', forced_unread = 1 WHERE id = ?`, id)
	return err
}

// MarkAllRead marks every currently-unread-in-this-app row read at once — the
// bulk "Alles gelezen maken" action, a sibling of MarkRead's per-row action.
// Deliberately WHERE read_at = '' (not "every row"), so a re-run (workflow
// replay, or a second bulk click) never overwrites an earlier read_at with a
// later one. WRITE — workflow-driven only.
func (m *Module) MarkAllRead(ctx context.Context, at string) error {
	if at == "" {
		at = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := m.db.ExecContext(ctx,
		`UPDATE jira_notifications SET read_at = ?, forced_unread = 0 WHERE read_at = ''`, at)
	return err
}

// List returns the newest limit notifications, unread ones included. READ —
// safe for the UI.
func (m *Module) List(ctx context.Context, limit int) ([]Item, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := m.db.QueryContext(ctx,
		`SELECT id, at, title, issue_key, actor, avatar_url, url, feed_unread, read_at,
		        issue_title, issue_status, issue_icon_url, group_size, other_actor, comment_preview,
		        forced_unread
		 FROM jira_notifications ORDER BY at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		var it Item
		var feedUnread int
		var readAt string
		var forcedUnread int
		if err := rows.Scan(&it.ID, &it.At, &it.Title, &it.IssueKey, &it.Actor, &it.AvatarURL, &it.URL, &feedUnread, &readAt,
			&it.IssueTitle, &it.IssueStatus, &it.IssueIconURL, &it.GroupSize, &it.OtherActor, &it.CommentPreview,
			&forcedUnread); err != nil {
			return nil, err
		}
		it.Unread = forcedUnread == 1 || (feedUnread == 1 && readAt == "")
		out = append(out, it)
	}
	return out, rows.Err()
}

// Purge deletes every notification older than before — the 30-day retention
// (see jiraNotifyRetention in cleanup.go). Returns how many rows went.
// WRITE — workflow-driven only.
func (m *Module) Purge(ctx context.Context, before time.Time) (int, error) {
	res, err := m.db.ExecContext(ctx,
		`DELETE FROM jira_notifications WHERE at < ?`, before.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}
