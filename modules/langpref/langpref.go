// Package langpref is the reviewer's repo-wide LANGUAGE preference, split per
// kind of output ("je moet per type kunnen vertalen"): the static interface
// copy, and the AI-generated explanations the reviewer reads, and the drafted
// reply that ends up on GitHub under the reviewer's own name. One Execution
// per repo, no PR scope — the same per-repo-tracker mould as
// modules/autowarn and modules/autoingestpref.
//
// Three kinds, two languages, default Dutch (KindUI/KindExplain/KindReply,
// LangNL/LangEN):
//
//   - "ui" — the static interface copy (src/i18n.mjs's t(), every label,
//     column title, row description and hint text). A frontend concern, but
//     stored server-side anyway so the choice is not per-browser and so a
//     fixed Dutch phrase that reaches the UI from Go can be translated at its
//     render site through the same dictionary.
//   - "explain" — the AI-generated prose the reviewer reads ABOUT the code:
//     the footer description (explain_code), the risk check (code_warning),
//     the PR summary, "since last review", comment titles, the chat summary,
//     the test report. Deliberately NOT the chat answers themselves: a chat
//     turn answers in the language the reviewer typed in (an explicit
//     reviewer decision), which needs no preference at all.
//   - "reply" — the body of a drafted reply to a review comment
//     (comment_action "reply"), i.e. the text that gets posted to GitHub with
//     the reviewer's own identity. Its own setting because the audience is
//     the PR's other readers, not the reviewer.
//
// The COMMIT language is deliberately not a kind here: code, identifiers,
// code comments and commit messages are always English (only the contents of
// a translation file may be another language). That is a fixed rule in the
// prompts, shown read-only on the settings page.
//
// Its WRITE method (SetLang) is driven only by a workflow Activity (per the
// project rule: only workflows mutate state); its READ method (Lang) backs
// the read-only GET /api/langpref and the prompt-building Activities
// themselves (TaskManager.LangFor). See
// .claude/rules/workflows-write-boundary.md and the skill add-module.
//
// Deliberately NOT localStorage/settings.json, same reasoning as autowarn and
// autoingestpref: the explain/reply language gates BACKEND behaviour (the
// language directive appended to a Claude call's system prompt, built at the
// moment the Activity runs), so the server must be able to read the current
// value instantly — unlike a pure frontend preference or a once-per-process
// file read. The "ui" kind rides along in the same store so all three live in
// one place; the frontend mirrors it into localStorage purely so the first
// paint is synchronous (see src/i18n.mjs).
package langpref

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS lang_pref (
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  lang TEXT NOT NULL,
  PRIMARY KEY (repo, kind)
);
`

// KindUI/KindExplain/KindReply are the three translatable output types.
const (
	KindUI      = "ui"
	KindExplain = "explain"
	KindReply   = "reply"
)

// LangNL/LangEN are the two valid languages. LangNL is the default everywhere,
// so a fresh install behaves exactly as before this preference existed —
// which is also why no prompt gains a language directive for it (see
// langDirective in explain.go).
const (
	LangNL = "nl"
	LangEN = "en"
)

// Kinds is the canonical kind list, in the order the settings page shows them.
var Kinds = []string{KindUI, KindExplain, KindReply}

// ValidKind/ValidLang are the guards the HTTP handler and the workflow apply
// before anything reaches this package (which itself only reads/writes
// whatever string it is given, like modules/autoingestpref).
func ValidKind(kind string) bool {
	return kind == KindUI || kind == KindExplain || kind == KindReply
}

func ValidLang(lang string) bool { return lang == LangNL || lang == LangEN }

// Module owns the language-preference store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("langpref: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("langpref: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("langpref: apply schema: %w", err)
	}
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

// Lang reports the language for one repo + kind, defaulting to LangNL when
// nothing was ever saved. READ — safe from anywhere, including directly from
// an Activity that is about to build a prompt.
func (m *Module) Lang(ctx context.Context, repo, kind string) (string, error) {
	var v string
	err := m.db.QueryRowContext(ctx, `SELECT lang FROM lang_pref WHERE repo = ? AND kind = ?`, repo, kind).Scan(&v)
	if err == sql.ErrNoRows {
		return LangNL, nil
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

// All reports every kind's language for repo, always with all three keys
// present (defaults filled in) — the shape GET /api/langpref returns.
func (m *Module) All(ctx context.Context, repo string) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range Kinds {
		out[k] = LangNL
	}
	rows, err := m.db.QueryContext(ctx, `SELECT kind, lang FROM lang_pref WHERE repo = ?`, repo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, lang string
		if err := rows.Scan(&kind, &lang); err != nil {
			return nil, err
		}
		if ValidKind(kind) {
			out[kind] = lang
		}
	}
	return out, rows.Err()
}

// SetLang persists one kind's language for repo. WRITE — call only from a
// workflow Activity. Idempotent (re-applying the same value is a no-op), so
// replay is safe.
func (m *Module) SetLang(ctx context.Context, repo, kind, lang string) error {
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO lang_pref (repo, kind, lang) VALUES (?, ?, ?)
		 ON CONFLICT(repo, kind) DO UPDATE SET lang = excluded.lang`, repo, kind, lang)
	return err
}
