// Package chat is the claude_chat module/service: a SQLite read-model of the
// embedded Claude conversation panel next to a review comment thread (see the
// claude_chat workflow in workflows.go and .claude/docs/tembed-workflows.md).
//
// One conversation hangs on exactly one existing comment thread (a
// task_code_comment Execution) — the conversation id IS that comment's id.
// Besides plain text turns, an assistant message may be a "question" turn
// (Kind "question"): a short clarifying question with up to a few Options,
// whose chosen Answer is recorded on the SAME row once the reviewer responds,
// so a refresh still shows which option (or free text) was picked without
// depending on message order.
//
// WRITE methods (SaveMessage/SetAnswer/SetSession) are driven only by
// workflow Activities (per .claude/rules/workflows-write-boundary.md); the
// READ methods (List/GetSession/ConversationsWithMessages) back the read-only
// UI/API.
package chat

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS chat_conversations (
  id         TEXT PRIMARY KEY, -- == the comment thread's own id
  pr         INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT '', -- the claude CLI's --session-id/--resume value
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  pr              INTEGER NOT NULL,
  role            TEXT NOT NULL,           -- 'user' | 'assistant'
  kind            TEXT NOT NULL DEFAULT '', -- '' (plain text) | 'question' | 'error' | 'action' | 'draft_reply'
  body            TEXT NOT NULL,
  options_json    TEXT NOT NULL DEFAULT '', -- JSON array of up to a few option strings ('question' only)
  answer          TEXT NOT NULL DEFAULT '', -- filled once the reviewer responds to a 'question' turn
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_pr ON chat_messages(pr);
`

// Kind values a message row can carry. "" is the default (a plain text turn).
const (
	KindQuestion = "question" // an assistant turn asking the reviewer to pick (or type) an answer
	KindError    = "error"    // an assistant turn reporting a failed Claude call
	// KindAction marks the confirmation turn shown after Claude — on the
	// reviewer's explicit request — successfully resolved the comment thread
	// this conversation hangs on (see chat_workflow.go's
	// applyChatCommentAction, the "claude_chat" opt-in influence path). A
	// FAILED attempt is stored as KindError instead, never KindAction, so the
	// Kind alone tells the reviewer whether it actually happened.
	KindAction = "action"
	// KindDraftReply marks a comment_action "reply" directive's drafted body —
	// Claude may draft a reply "on the reviewer's behalf", but unlike
	// KindAction it is NEVER signalled onto the comment thread by itself. The
	// frontend (RelatedPanel.mjs's applyPendingDraftReplies) merges Body into
	// the left thread's own reply composer instead, so only the reviewer's own
	// edit + explicit send ever posts anything there.
	KindDraftReply = "draft_reply"
)

// Message is one turn in a conversation.
type Message struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	PR             int    `json:"pr"`
	Role           string `json:"role"` // "user" | "assistant"
	Kind           string `json:"kind,omitempty"`
	Body           string `json:"body"`
	// Options is only set for a Kind == KindQuestion assistant turn — the
	// small set of choices offered alongside free text (capped by the caller,
	// see runClaudeTurn in workflows.go).
	Options []string `json:"options,omitempty"`
	// Answer is filled in-place on a KindQuestion row once the reviewer's next
	// message answers it (SetAnswer), so a refresh still shows the picked
	// option (or typed free text) tied to its own question, regardless of
	// message ordering.
	Answer    string `json:"answer,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// Module owns the chat store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the chat DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("chat: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("chat: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("chat: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// EnsureConversation creates the conversation row if it doesn't exist yet
// (idempotent — a repeated call for the same id is a no-op). WRITE —
// workflow-Activity-only.
func (m *Module) EnsureConversation(ctx context.Context, id string, pr int) error {
	ts := now()
	_, err := m.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO chat_conversations (id, pr, session_id, created_at, updated_at)
		 VALUES (?,?,'',?,?)`, id, pr, ts, ts)
	return err
}

// SetSession records the claude CLI session id a conversation continues with
// (see claude.ChatResult.SessionID). WRITE — workflow-Activity-only.
func (m *Module) SetSession(ctx context.Context, conversationID, sessionID string) error {
	_, err := m.db.ExecContext(ctx,
		`UPDATE chat_conversations SET session_id = ?, updated_at = ? WHERE id = ?`,
		sessionID, now(), conversationID)
	return err
}

// GetSession returns the conversation's stored session id ("" if unknown/no
// session yet, e.g. the first turn). READ — safe for the UI/API, also used by
// the runClaudeTurn Activity to decide --session-id vs --resume.
func (m *Module) GetSession(ctx context.Context, conversationID string) (string, error) {
	var sessionID string
	err := m.db.QueryRowContext(ctx,
		`SELECT session_id FROM chat_conversations WHERE id = ?`, conversationID).Scan(&sessionID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return sessionID, err
}

// SaveMessage persists one turn (idempotent on ID, so a retried Activity never
// double-inserts). WRITE — workflow-Activity-only.
func (m *Module) SaveMessage(ctx context.Context, msg Message) error {
	if msg.CreatedAt == "" {
		msg.CreatedAt = now()
	}
	optsJSON := ""
	if len(msg.Options) > 0 {
		b, err := json.Marshal(msg.Options)
		if err != nil {
			return fmt.Errorf("chat: marshal options: %w", err)
		}
		optsJSON = string(b)
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO chat_messages
		   (id, conversation_id, pr, role, kind, body, options_json, answer, created_at)
		 VALUES (?,?,?,?,?,?,?,
		   COALESCE((SELECT answer FROM chat_messages WHERE id = ?), ''),
		   ?)`,
		msg.ID, msg.ConversationID, msg.PR, msg.Role, msg.Kind, msg.Body, optsJSON, msg.ID, msg.CreatedAt)
	return err
}

// SetAnswer records the reviewer's response to a KindQuestion message (the
// chosen option's text, or free text they typed instead). A no-op (returns
// nil) if id doesn't exist — best-effort, mirroring how a stale/expired
// question is simply left alone rather than failing the workflow. WRITE —
// workflow-Activity-only.
func (m *Module) SetAnswer(ctx context.Context, id, answer string) error {
	_, err := m.db.ExecContext(ctx, `UPDATE chat_messages SET answer = ? WHERE id = ?`, answer, id)
	return err
}

// ClearConversation wipes one conversation's transcript and stored claude
// session ("wis gesprek") — never the conversation row itself, so the id keeps
// anchoring to the same comment thread and the next turn simply starts a
// fresh session instead of --resume-ing the wiped one. WRITE — driven only by
// the claude_chat workflow's clearChatConversation Activity (chat_workflow.go).
func (m *Module) ClearConversation(ctx context.Context, id string) error {
	if _, err := m.db.ExecContext(ctx, `DELETE FROM chat_messages WHERE conversation_id = ?`, id); err != nil {
		return err
	}
	_, err := m.db.ExecContext(ctx,
		`UPDATE chat_conversations SET session_id = '', updated_at = ? WHERE id = ?`, now(), id)
	return err
}

// Purge removes every conversation + message row of pr. WRITE — workflow-only,
// the per-PR data-retention cleanup path (see the cleanup workflow). Returns
// the number of messages removed, for logging.
func (m *Module) Purge(ctx context.Context, pr int) (int64, error) {
	if _, err := m.db.ExecContext(ctx, `DELETE FROM chat_conversations WHERE pr = ?`, pr); err != nil {
		return 0, err
	}
	res, err := m.db.ExecContext(ctx, `DELETE FROM chat_messages WHERE pr = ?`, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ConversationsWithMessages returns the ids of every conversation of pr that
// has at least one message — i.e. "here a Claude conversation really happened",
// without any bodies. READ — safe for the UI/API. It backs the frontend's
// "should the chat column exist at all" question for a whole PR in one request:
// a conversation must stay reachable once it has turns, even if its comment is
// no longer among the visible ones (see claudeChatVisible in RelatedPanel.mjs).
// A conversation row that only ever got ensured (no turns) is deliberately not
// reported — nothing to come back to.
func (m *Module) ConversationsWithMessages(ctx context.Context, pr int) ([]string, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT DISTINCT conversation_id FROM chat_messages WHERE pr = ? ORDER BY conversation_id`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// List returns every message of one conversation, oldest first. READ — safe
// for the UI/API.
func (m *Module) List(ctx context.Context, conversationID string) ([]Message, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT id, conversation_id, pr, role, kind, body, options_json, answer, created_at
		 FROM chat_messages WHERE conversation_id = ? ORDER BY created_at`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var msg Message
		var optsJSON string
		if err := rows.Scan(&msg.ID, &msg.ConversationID, &msg.PR, &msg.Role, &msg.Kind,
			&msg.Body, &optsJSON, &msg.Answer, &msg.CreatedAt); err != nil {
			return nil, err
		}
		if optsJSON != "" {
			_ = json.Unmarshal([]byte(optsJSON), &msg.Options)
		}
		out = append(out, msg)
	}
	return out, rows.Err()
}
