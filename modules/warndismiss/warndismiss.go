// Package warndismiss remembers which AI risk findings (code_warning) the
// reviewer has already dealt with, so a later run of the same check does not
// raise them again.
//
// Why it has to be durable: the risk check re-runs automatically on every
// ingest refresh that brings real new code, and supersedeFileWarnings wipes
// the previous run's findings for the files in scope before the fresh pass.
// So a finding the reviewer resolved (or deleted outright) came straight back
// as a new open comment on the next run — "ik kan ai waarschuwing niet
// resolven of verwijderen". Neither the comments read-model nor the workflow
// history can answer this: a deleted comment leaves no row at all, and a
// resolved one is deleted by the very supersede that precedes the next run.
//
// A dismissal is identified by (pr, file, Fingerprint(body)) — deliberately
// the finding's TEXT, not its line: the same risk re-reported after a commit
// usually shifts line, and the text is what the reviewer actually judged.
// The fingerprint stays the hard identity/filter (an exact, normalised-text
// repeat is dropped in Go, unconditionally). On top of that the finding's own
// TEXT is also stored (List, below) and handed to the code_warning prompt as
// context, so the model itself can additionally recognise a REPHRASED repeat
// of the same risk — a best-effort judgment call, not a second hard filter.
//
// Its WRITE method (Add) is driven only by a workflow Activity (per the
// project rule: only workflows mutate state); its READ method (Fingerprints)
// is safe from anywhere. See .claude/rules/workflows-write-boundary.md.
package warndismiss

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
)

const schema = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS dismissed_warnings (
  repo        TEXT    NOT NULL DEFAULT '',  -- canonical repo string: '' = the primary repo
  pr          INTEGER NOT NULL,
  file        TEXT    NOT NULL,
  fingerprint TEXT    NOT NULL,
  text        TEXT    NOT NULL DEFAULT '',  -- the dismissed finding's own wording, see List
  created_at  TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (repo, pr, file, fingerprint)
);
`

// Module owns the dismissed-findings store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the warndismiss DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("warndismiss: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("warndismiss: apply schema: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateText(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("warndismiss: apply schema: %w", err)
	}
	if err := migrate(db); err != nil {
		return nil, err
	}
	if err := migrateText(db); err != nil {
		return nil, err
	}
	return &Module{db: db}, nil
}

// migrate brings a pre-multi-repo table up to PRIMARY KEY (repo, pr, file,
// fingerprint). Unlike most tables this one cannot be a plain ADD COLUMN: its key
// is (pr, file, fingerprint), all three of which two different repos can share
// (same PR number, same path, same finding text), so a dismissal in one repo
// would silence the other's identical finding. SQLite can't alter a PK, so the
// table is rebuilt and copied with repo=” — every existing dismissal belongs to
// the primary repo. See repos.go.
func migrate(db *sql.DB) error {
	hasRepo, err := columnExists(db, "dismissed_warnings", "repo")
	if err != nil || hasRepo {
		return err
	}
	for _, q := range []string{
		`CREATE TABLE dismissed_warnings_new (
			repo TEXT NOT NULL DEFAULT '', pr INTEGER NOT NULL, file TEXT NOT NULL,
			fingerprint TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (repo, pr, file, fingerprint))`,
		`INSERT INTO dismissed_warnings_new (repo, pr, file, fingerprint, created_at)
			SELECT '', pr, file, fingerprint, created_at FROM dismissed_warnings`,
		`DROP TABLE dismissed_warnings`,
		`ALTER TABLE dismissed_warnings_new RENAME TO dismissed_warnings`,
	} {
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("warndismiss: migrate repo: %w", err)
		}
	}
	return nil
}

// migrateText brings a pre-text table up to the current schema. Unlike the
// repo migration above this is a plain additive column — text is not part of
// the primary key — so no table rebuild is needed; an existing row simply
// reads back with text = ” until it is dismissed again.
func migrateText(db *sql.DB) error {
	hasText, err := columnExists(db, "dismissed_warnings", "text")
	if err != nil || hasText {
		return err
	}
	if _, err := db.Exec(`ALTER TABLE dismissed_warnings ADD COLUMN text TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("warndismiss: migrate text: %w", err)
	}
	return nil
}

// columnExists reports whether table has a column of that name.
func columnExists(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`, table, column)
	if err != nil {
		return false, fmt.Errorf("warndismiss: inspect %s: %w", table, err)
	}
	defer rows.Close()
	return rows.Next(), rows.Err()
}

func (m *Module) Close() error { return m.db.Close() }

// Fingerprint is the stable identity of one finding's text: lowercased, with
// every run of whitespace collapsed to a single space, hashed. Exported
// because both sides need the exact same value — the writer (a dismissed
// comment's body) and the reader (a fresh finding's text).
func Fingerprint(text string) string {
	norm := strings.ToLower(strings.Join(strings.Fields(text), " "))
	if norm == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// Add records that the finding with this fingerprint, on this file of this
// PR, was dismissed — and stores its own wording (text) alongside, so a later
// code_warning run can hand it to the model as "already dismissed, don't
// repeat this even reworded" context (see List). Idempotent on the
// fingerprint (the PK swallows a repeat), so replaying the Activity that
// calls it is safe. An empty fingerprint (an empty finding body) is ignored —
// it would match every other empty one. WRITE: call only from a workflow
// Activity.
func (m *Module) Add(ctx context.Context, repo string, pr int, file, fingerprint, text, at string) error {
	if fingerprint == "" {
		return nil
	}
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO dismissed_warnings (repo, pr, file, fingerprint, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(repo, pr, file, fingerprint) DO NOTHING`, repo, pr, file, fingerprint, text, at)
	return err
}

// Fingerprints returns every dismissed fingerprint of a PR, keyed by
// "<file>\x00<fingerprint>" so a caller can test one lookup per finding. READ
// — safe from anywhere.
func (m *Module) Fingerprints(ctx context.Context, repo string, pr int) (map[string]bool, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT file, fingerprint FROM dismissed_warnings WHERE repo = ? AND pr = ?`, repo, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var file, fp string
		if err := rows.Scan(&file, &fp); err != nil {
			return nil, err
		}
		out[Key(file, fp)] = true
	}
	return out, rows.Err()
}

// Key builds the lookup key Fingerprints returns, so callers never spell the
// separator themselves.
func Key(file, fingerprint string) string { return file + "\x00" + fingerprint }

// DismissedFinding is one earlier finding's own file + wording, as handed to
// the code_warning prompt so the model can recognise a reworded repeat of a
// risk the reviewer already dealt with (see List).
type DismissedFinding struct {
	File string
	Text string
}

// List returns every dismissed finding of a PR (file + its own text), in a
// stable order (file, then created_at). READ — safe from anywhere. A finding
// dismissed before the text column existed reads back with an empty Text and
// is simply skipped by a caller that only wants non-empty wording.
func (m *Module) List(ctx context.Context, repo string, pr int) ([]DismissedFinding, error) {
	rows, err := m.db.QueryContext(ctx,
		`SELECT file, text FROM dismissed_warnings WHERE repo = ? AND pr = ? ORDER BY file, created_at`, repo, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DismissedFinding
	for rows.Next() {
		var d DismissedFinding
		if err := rows.Scan(&d.File, &d.Text); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
