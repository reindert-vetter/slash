package main

import (
	"database/sql"
	"fmt"

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
  side       TEXT NOT NULL DEFAULT 'new',
  pr         INTEGER NOT NULL DEFAULT 0,
  approved   INTEGER NOT NULL DEFAULT 0
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
		INSERT INTO blocks (id, name, class, file, category, line, end_line, status, side, pr, approved)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, b := range blocks {
		approved := 0
		if b.Approved {
			approved = 1
		}
		if _, err := stmt.Exec(b.ID(), b.Name, b.Class, b.File, b.Category,
			b.Line, b.EndLine, b.Status, b.Side, b.PR, approved); err != nil {
			return fmt.Errorf("insert block %s: %w", b.ID(), err)
		}
	}
	return tx.Commit()
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

// blocksByPR reads all blocks of one PR, stably sorted by (file, line).
func blocksByPR(db *sql.DB, pr int) ([]Block, error) {
	rows, err := db.Query(`
		SELECT name, class, file, category, line, end_line, status, side, pr, approved
		FROM blocks WHERE pr = ?
		ORDER BY file, line`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Block
	for rows.Next() {
		var b Block
		var approved int
		if err := rows.Scan(&b.Name, &b.Class, &b.File, &b.Category,
			&b.Line, &b.EndLine, &b.Status, &b.Side, &b.PR, &approved); err != nil {
			return nil, err
		}
		b.Approved = approved == 1
		b.makeLabel()
		out = append(out, b)
	}
	return out, rows.Err()
}
