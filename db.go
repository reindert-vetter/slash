package main

import (
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

// schemaDDL is the source of truth for storage; keep it in sync with
// .claude/templates/schema.sql (the documented template).
const schemaDDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS blocks (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  class      TEXT NOT NULL DEFAULT '',
  file       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',
  line       INTEGER NOT NULL,
  end_line   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT '',
  file_deleted INTEGER NOT NULL DEFAULT 0,
  side       TEXT NOT NULL DEFAULT 'new',
  pr         INTEGER NOT NULL DEFAULT 0,
  approved   INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT ''    -- vrije tekst uit een PHPDoc /** ... */ direct boven
                                           -- de declaratie (@tags gestript); deterministisch, geen AI
);

CREATE TABLE IF NOT EXISTS edges (
  caller_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  callee_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  PRIMARY KEY (caller_id, callee_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_id);
CREATE INDEX IF NOT EXISTS idx_blocks_approved ON blocks(approved);
CREATE INDEX IF NOT EXISTS idx_blocks_pr ON blocks(pr);
CREATE INDEX IF NOT EXISTS idx_blocks_pr_status ON blocks(pr, status);

-- pr_ingest records the base/head SHA the blocks table was last populated
-- from, per PR. The ingest-refresh path (pr_status's SignalPRState branch,
-- see refreshIngestDelta) diffs the previously-recorded head SHA against a
-- newly observed one to discover exactly which files changed since, instead
-- of re-scanning the whole PR on every refresh.
CREATE TABLE IF NOT EXISTS pr_ingest (
  pr       INTEGER PRIMARY KEY,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL
);
`

// openDB opens (or creates) the SQLite DB and applies the schema.
func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	if _, err := db.Exec(schemaDDL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	// Light migration for DBs created before the file_deleted column existed
	// (CREATE TABLE IF NOT EXISTS won't add it) — same pattern as the
	// comments/relations modules: ignore the duplicate-column error.
	if _, err := db.Exec(`ALTER TABLE blocks ADD COLUMN file_deleted INTEGER NOT NULL DEFAULT 0`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		db.Close()
		return nil, fmt.Errorf("migrate blocks.file_deleted: %w", err)
	}
	// Same pattern for the PHPDoc-derived description column.
	if _, err := db.Exec(`ALTER TABLE blocks ADD COLUMN description TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		db.Close()
		return nil, fmt.Errorf("migrate blocks.description: %w", err)
	}
	return db, nil
}

// replacePRBlocks replaces all blocks of one PR in a single transaction
// (idempotent re-ingest: DELETE + bulk INSERT).
func replacePRBlocks(db *sql.DB, pr int, blocks []Block) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM blocks WHERE pr = ?`, pr); err != nil {
		return fmt.Errorf("delete pr blocks: %w", err)
	}

	stmt, err := tx.Prepare(`
		INSERT INTO blocks (id, name, class, file, category, line, end_line, status, file_deleted, side, pr, approved, description)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, b := range blocks {
		approved := 0
		if b.Approved {
			approved = 1
		}
		fileDeleted := 0
		if b.FileDeleted {
			fileDeleted = 1
		}
		if _, err := stmt.Exec(b.ID(), b.Name, b.Class, b.File, b.Category,
			b.Line, b.EndLine, b.Status, fileDeleted, b.Side, b.PR, approved, b.Description); err != nil {
			return fmt.Errorf("insert block %s: %w", b.ID(), err)
		}
	}
	return tx.Commit()
}

// upsertPRFileBlocks scopes an ingest write to exactly the given files: it
// deletes only the PR's blocks whose file is in files, then inserts blocks —
// every other file's blocks are left completely untouched, and so is anything
// keyed off a block's stable id (`pr:file:class::name`) in the separate
// comments/approvals/callresolve read-models (they live in their own SQLite
// files with no FK to this table). This is the incremental-refresh
// counterpart to replacePRBlocks's full per-PR swap — the write path for
// refreshIngestDelta. A no-op for an empty files list.
func upsertPRFileBlocks(db *sql.DB, pr int, files []string, blocks []Block) error {
	if len(files) == 0 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ph := make([]string, len(files))
	args := make([]any, 0, len(files)+1)
	args = append(args, pr)
	for i, f := range files {
		ph[i] = "?"
		args = append(args, f)
	}
	q := `DELETE FROM blocks WHERE pr = ? AND file IN (` + strings.Join(ph, ",") + `)`
	if _, err := tx.Exec(q, args...); err != nil {
		return fmt.Errorf("delete delta blocks: %w", err)
	}

	stmt, err := tx.Prepare(`
		INSERT INTO blocks (id, name, class, file, category, line, end_line, status, file_deleted, side, pr, approved, description)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, b := range blocks {
		approved := 0
		if b.Approved {
			approved = 1
		}
		fileDeleted := 0
		if b.FileDeleted {
			fileDeleted = 1
		}
		if _, err := stmt.Exec(b.ID(), b.Name, b.Class, b.File, b.Category,
			b.Line, b.EndLine, b.Status, fileDeleted, b.Side, b.PR, approved, b.Description); err != nil {
			return fmt.Errorf("insert block %s: %w", b.ID(), err)
		}
	}
	return tx.Commit()
}

// saveIngestSHAs records the base/head SHA a PR's blocks table was last
// populated from (by a full ingest or a delta refresh), so a later refresh
// knows exactly which head SHA to diff from. WRITE — call only from an ingest
// Activity.
func saveIngestSHAs(db *sql.DB, pr int, base, head string) error {
	_, err := db.Exec(`
		INSERT INTO pr_ingest (pr, base_sha, head_sha) VALUES (?, ?, ?)
		ON CONFLICT(pr) DO UPDATE SET base_sha = excluded.base_sha, head_sha = excluded.head_sha`,
		pr, base, head)
	return err
}

// loadIngestSHAs returns the base/head SHA recorded for pr's last ingest, and
// whether one has ever been recorded (false before the first successful
// ingest). Read-only — safe to call from the ingest-refresh poller.
func loadIngestSHAs(db *sql.DB, pr int) (base, head string, ok bool, err error) {
	err = db.QueryRow(`SELECT base_sha, head_sha FROM pr_ingest WHERE pr = ?`, pr).Scan(&base, &head)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return base, head, true, nil
}

// blockFileExists reports whether the PR has any stored block in the given
// file. It guards /api/code against reading arbitrary paths off disk.
func blockFileExists(db *sql.DB, pr int, file string) (bool, error) {
	var n int
	if err := db.QueryRow(
		`SELECT COUNT(1) FROM blocks WHERE pr = ? AND file = ?`, pr, file,
	).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// PRSummary is one row of the PR overview: a PR and how many blocks it holds.
type PRSummary struct {
	PR     int    `json:"pr"`
	Blocks int    `json:"blocks"`
	Files  int    `json:"files"`
	Title  string `json:"title"` // filled by handlePRs from the prmeta read-model (empty when unknown)
}

// listPRs returns every ingested PR with its block/file counts, newest PR first.
// Feeds the /pr-overview page.
func listPRs(db *sql.DB) ([]PRSummary, error) {
	rows, err := db.Query(`
		SELECT pr, COUNT(*) AS blocks, COUNT(DISTINCT file) AS files
		FROM blocks
		GROUP BY pr
		ORDER BY pr DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PRSummary
	for rows.Next() {
		var s PRSummary
		if err := rows.Scan(&s.PR, &s.Blocks, &s.Files); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// blocksByPR reads all blocks of one PR, stably sorted by (file, line).
func blocksByPR(db *sql.DB, pr int) ([]Block, error) {
	rows, err := db.Query(`
		SELECT name, class, file, category, line, end_line, status, file_deleted, side, pr, approved, description
		FROM blocks WHERE pr = ?
		ORDER BY file, line`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Block
	for rows.Next() {
		var b Block
		var approved, fileDeleted int
		if err := rows.Scan(&b.Name, &b.Class, &b.File, &b.Category,
			&b.Line, &b.EndLine, &b.Status, &fileDeleted, &b.Side, &b.PR, &approved, &b.Description); err != nil {
			return nil, err
		}
		b.Approved = approved == 1
		b.FileDeleted = fileDeleted == 1
		b.makeLabel()
		out = append(out, b)
	}
	return out, rows.Err()
}
