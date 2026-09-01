package main

import (
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"

	"slash/modules/sqlitedsn"
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
  old_file   TEXT NOT NULL DEFAULT '',   -- pre-rename path when the PR moved this
                                          -- block's file (git-detected rename); '' otherwise
  old_class  TEXT NOT NULL DEFAULT '',   -- pre-move class/name/line when the PR renamed or moved
  old_name   TEXT NOT NULL DEFAULT '',   -- this block (same body, different symbol — blockmove.go);
  old_line   INTEGER NOT NULL DEFAULT 0, -- '' / 0 otherwise
  side       TEXT NOT NULL DEFAULT 'new',
  repo       TEXT NOT NULL DEFAULT '',    -- canonical repo string: '' = the primary repo
                                          -- (see repos.go), 'owner/name' for any other
  pr         INTEGER NOT NULL DEFAULT 0,
  approved   INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT ''    -- free text from a PHPDoc /** ... */ directly above
                                           -- the declaration (@tags stripped); deterministic, no AI
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
  repo     TEXT NOT NULL DEFAULT '',
  pr       INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
`

// openDB opens (or creates) the SQLite DB and applies the schema.
//
// Through sqlitedsn.DSN for the busy_timeout, exactly like every module store
// (and tembed's own): the blocks DB has the same concurrent writers — an
// ingest/refresh Activity writing while a reviewer's request reads — and
// without it one of them fails on the spot with SQLITE_BUSY instead of waiting
// out the lock. See modules/sqlitedsn.
func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
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
	// Same pattern for the rename old_file column.
	if _, err := db.Exec(`ALTER TABLE blocks ADD COLUMN old_file TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		db.Close()
		return nil, fmt.Errorf("migrate blocks.old_file: %w", err)
	}
	// Same pattern for the rename/move old_class, old_name and old_line
	// columns (blockmove.go's PR-wide moved-block detection).
	for _, q := range []string{
		`ALTER TABLE blocks ADD COLUMN old_class TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE blocks ADD COLUMN old_name TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE blocks ADD COLUMN old_line INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := db.Exec(q); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			db.Close()
			return nil, fmt.Errorf("migrate blocks move columns: %w", err)
		}
	}
	// And for the repo column (multi-repo support, see repos.go). Every row that
	// predates it belongs to the primary repo, which IS the '' default — so this
	// is a pure ALTER with no backfill.
	if _, err := db.Exec(`ALTER TABLE blocks ADD COLUMN repo TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		db.Close()
		return nil, fmt.Errorf("migrate blocks.repo: %w", err)
	}
	// The repo-scoped indexes are created here, not in schemaDDL: schemaDDL runs
	// against an EXISTING db before the ALTER above, where a `repo` column does
	// not exist yet — the same reason modules/comments keeps its path index out of
	// its schema.
	for _, q := range []string{
		`CREATE INDEX IF NOT EXISTS idx_blocks_repo_pr ON blocks(repo, pr)`,
		`CREATE INDEX IF NOT EXISTS idx_blocks_repo_pr_status ON blocks(repo, pr, status)`,
	} {
		if _, err := db.Exec(q); err != nil {
			db.Close()
			return nil, fmt.Errorf("index %s: %w", q, err)
		}
	}
	if err := migratePRIngestRepo(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// migratePRIngestRepo brings a pre-multi-repo pr_ingest table (PRIMARY KEY on
// the bare pr) up to PRIMARY KEY (repo, pr). Unlike blocks, this one cannot be a
// plain ALTER: the PK itself has to change, or PR 12 of a second repo would
// overwrite PR 12 of the primary one. SQLite can't alter a PK, so the table is
// rebuilt and copied — it holds two SHAs per PR, derived data that is rewritten
// on every ingest anyway, so the copy is cheap and losing it would at worst force
// one full re-scan.
func migratePRIngestRepo(db *sql.DB) error {
	var hasRepo bool
	rows, err := db.Query(`PRAGMA table_info(pr_ingest)`)
	if err != nil {
		return fmt.Errorf("inspect pr_ingest: %w", err)
	}
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var dflt any
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			rows.Close()
			return fmt.Errorf("inspect pr_ingest: %w", err)
		}
		if name == "repo" {
			hasRepo = true
		}
	}
	rows.Close()
	if hasRepo {
		return nil
	}
	stmts := []string{
		`CREATE TABLE pr_ingest_new (
			repo TEXT NOT NULL DEFAULT '', pr INTEGER NOT NULL,
			base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, PRIMARY KEY (repo, pr))`,
		`INSERT INTO pr_ingest_new (repo, pr, base_sha, head_sha) SELECT '', pr, base_sha, head_sha FROM pr_ingest`,
		`DROP TABLE pr_ingest`,
		`ALTER TABLE pr_ingest_new RENAME TO pr_ingest`,
	}
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("migrate pr_ingest.repo: %w", err)
		}
	}
	return nil
}

// replacePRBlocks replaces all blocks of one PR in a single transaction
// (idempotent re-ingest: DELETE + bulk INSERT).
func replacePRBlocks(db *sql.DB, repo string, pr int, blocks []Block) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM blocks WHERE repo = ? AND pr = ?`, repo, pr); err != nil {
		return fmt.Errorf("delete pr blocks: %w", err)
	}

	stmt, err := tx.Prepare(`
		INSERT INTO blocks (id, name, class, file, category, line, end_line, status, file_deleted, old_file, old_class, old_name, old_line, side, repo, pr, approved, description)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
			b.Line, b.EndLine, b.Status, fileDeleted, b.OldFile, b.OldClass, b.OldName, b.OldLine, b.Side, b.Repo, b.PR, approved, b.Description); err != nil {
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
func upsertPRFileBlocks(db *sql.DB, repo string, pr int, files []string, blocks []Block) error {
	if len(files) == 0 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ph := make([]string, len(files))
	args := make([]any, 0, len(files)+2)
	args = append(args, repo, pr)
	for i, f := range files {
		ph[i] = "?"
		args = append(args, f)
	}
	q := `DELETE FROM blocks WHERE repo = ? AND pr = ? AND file IN (` + strings.Join(ph, ",") + `)`
	if _, err := tx.Exec(q, args...); err != nil {
		return fmt.Errorf("delete delta blocks: %w", err)
	}

	stmt, err := tx.Prepare(`
		INSERT INTO blocks (id, name, class, file, category, line, end_line, status, file_deleted, old_file, old_class, old_name, old_line, side, repo, pr, approved, description)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
			b.Line, b.EndLine, b.Status, fileDeleted, b.OldFile, b.OldClass, b.OldName, b.OldLine, b.Side, b.Repo, b.PR, approved, b.Description); err != nil {
			return fmt.Errorf("insert block %s: %w", b.ID(), err)
		}
	}
	return tx.Commit()
}

// saveIngestSHAs records the base/head SHA a PR's blocks table was last
// populated from (by a full ingest or a delta refresh), so a later refresh
// knows exactly which head SHA to diff from. WRITE — call only from an ingest
// Activity.
func saveIngestSHAs(db *sql.DB, repo string, pr int, base, head string) error {
	_, err := db.Exec(`
		INSERT INTO pr_ingest (repo, pr, base_sha, head_sha) VALUES (?, ?, ?, ?)
		ON CONFLICT(repo, pr) DO UPDATE SET base_sha = excluded.base_sha, head_sha = excluded.head_sha`,
		repo, pr, base, head)
	return err
}

// loadIngestSHAs returns the base/head SHA recorded for pr's last ingest, and
// whether one has ever been recorded (false before the first successful
// ingest). Read-only — safe to call from the ingest-refresh poller.
func loadIngestSHAs(db *sql.DB, repo string, pr int) (base, head string, ok bool, err error) {
	err = db.QueryRow(`SELECT base_sha, head_sha FROM pr_ingest WHERE repo = ? AND pr = ?`, repo, pr).Scan(&base, &head)
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
func blockFileExists(db *sql.DB, repo string, pr int, file string) (bool, error) {
	var n int
	if err := db.QueryRow(
		`SELECT COUNT(1) FROM blocks WHERE repo = ? AND pr = ? AND file = ?`, repo, pr, file,
	).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// PRSummary is one row of the PR overview: a PR and how many blocks it holds.
type PRSummary struct {
	// Repo is the canonical repo string ("" = the primary repo, see repos.go).
	Repo   string `json:"repo,omitempty"`
	PR     int    `json:"pr"`
	Blocks int    `json:"blocks"`
	Files  int    `json:"files"`
	Title  string `json:"title"` // filled by handlePRs from the prmeta read-model (empty when unknown)
	// The fields below are also filled by handlePRs from the same prmeta.Get
	// call as Title — one local SQLite read already made per row, no extra
	// query and no GitHub call — so the "Recent gegenereerd" drawer can render
	// the same author/diffstat/branch/updated-at look as the inbox rows
	// (authorMark/diffStatFragment/branchFragment/relativeTime in
	// overview.mjs) without a slower page load. Empty/zero when the PR was
	// never opened via /pr/<id> (the pr_status tracker never ran for it).
	Author       string `json:"author,omitempty"`
	Additions    int    `json:"additions,omitempty"`
	Deletions    int    `json:"deletions,omitempty"`
	ChangedFiles int    `json:"changedFiles,omitempty"`
	HeadRefName  string `json:"headRefName,omitempty"` // mapped from prmeta.Meta.HeadRef, named to match branchFragment's pr.headRefName
	// UpdatedAt is the PR's own GitHub updatedAt (prmeta.Meta.GhUpdatedAt), the
	// same moment the inbox rows show — deliberately NOT prmeta.Meta.UpdatedAt,
	// which is only the local write time of that row.
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// listPRs returns every ingested PR with its block/file counts, newest PR first.
// Feeds the /pr-overview page.
func listPRs(db *sql.DB) ([]PRSummary, error) {
	rows, err := db.Query(`
		SELECT repo, pr, COUNT(*) AS blocks, COUNT(DISTINCT file) AS files
		FROM blocks
		GROUP BY repo, pr
		ORDER BY pr DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PRSummary
	for rows.Next() {
		var s PRSummary
		if err := rows.Scan(&s.Repo, &s.PR, &s.Blocks, &s.Files); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// purgePRBlocks removes every stored block and the ingest-SHA record of pr —
// the graph.db half of the cleanup workflow's per-PR data-retention purge
// (the other tables live in the separate module DBs, see each module's own
// Purge). WRITE — call only from the cleanup workflow's purgePR Activity.
// Returns the number of block rows removed, for logging.
func purgePRBlocks(db *sql.DB, repo string, pr int) (int, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`DELETE FROM blocks WHERE repo = ? AND pr = ?`, repo, pr)
	if err != nil {
		return 0, fmt.Errorf("delete pr blocks: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`DELETE FROM pr_ingest WHERE repo = ? AND pr = ?`, repo, pr); err != nil {
		return int(n), fmt.Errorf("delete pr_ingest: %w", err)
	}
	return int(n), tx.Commit()
}

// blocksByPR reads all blocks of one PR, stably sorted by (file, line).
func blocksByPR(db *sql.DB, repo string, pr int) ([]Block, error) {
	rows, err := db.Query(`
		SELECT name, class, file, category, line, end_line, status, file_deleted, old_file, old_class, old_name, old_line, side, repo, pr, approved, description
		FROM blocks WHERE repo = ? AND pr = ?
		ORDER BY file, line`, repo, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Block
	for rows.Next() {
		var b Block
		var approved, fileDeleted int
		if err := rows.Scan(&b.Name, &b.Class, &b.File, &b.Category,
			&b.Line, &b.EndLine, &b.Status, &fileDeleted, &b.OldFile, &b.OldClass, &b.OldName, &b.OldLine, &b.Side, &b.Repo, &b.PR, &approved, &b.Description); err != nil {
			return nil, err
		}
		b.Approved = approved == 1
		b.FileDeleted = fileDeleted == 1
		b.makeLabel()
		out = append(out, b)
	}
	return out, rows.Err()
}

// pruneBlocksOutsidePRFiles deletes the PR's blocks for every file that is not
// in files — the set GitHub itself reports as the PR's changed files. It keeps
// the blocks table's invariant that a PR only ever holds blocks for files the
// PR actually touches, which a delta refresh can otherwise break: the delta is
// computed over prevHead..headSHA, so merging the base branch INTO the head
// pulls in every file that branch touched meanwhile (see refreshIngestDelta).
//
// Also the cleanup for a rename's OLD path: gh lists only the new path, so the
// old one falls outside files and its stale rows go here.
//
// A no-op for an empty files list — "GitHub told us nothing" must never be read
// as "this PR has no files", which would wipe the whole tree.
func pruneBlocksOutsidePRFiles(db *sql.DB, repo string, pr int, files []string) (int, error) {
	if len(files) == 0 {
		return 0, nil
	}
	ph := make([]string, len(files))
	args := make([]any, 0, len(files)+2)
	args = append(args, repo, pr)
	for i, f := range files {
		ph[i] = "?"
		args = append(args, f)
	}
	q := `DELETE FROM blocks WHERE repo = ? AND pr = ? AND file NOT IN (` + strings.Join(ph, ",") + `)`
	res, err := db.Exec(q, args...)
	if err != nil {
		return 0, fmt.Errorf("prune blocks outside pr files: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return int(n), nil
}
