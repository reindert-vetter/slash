// Package testcovers is the test-coverage module/service: a SQLite read-model
// that couples a PHPUnit test method to the method it covers — in both
// directions the "Onderliggende code" panel needs: a test → its covered
// (possibly UNCHANGED) production method, and a production method → the test
// that covers it. It mirrors modules/callresolve closely (child descriptor +
// code snapshot, LLM-owned statuses preserved across a Go rebuild), because a
// covered method can live in a file the PR did not change.
//
// Coverage is detected two ways:
//   - A method-level annotation (#[CoversMethod], "@covers Class::method", or
//     "@coversDefaultClass" + "@covers ::method") names BOTH the class and the
//     method, so it resolves statically — no AI, ever.
//   - A class-level-only annotation (#[CoversClass], bare "@covers Class")
//     names only a class; which method it covers is inferred by an LLM
//     (Haiku, escalating to Sonnet), verified against the worktree.
//   - No annotation at all is a distinct terminal status ("unannotated") that
//     NEVER triggers AI — the UI shows a warning instead.
//
// WRITE methods (UpsertGo/SaveSearching/Save) are driven only by workflow
// Activities (per .claude/rules/workflows-write-boundary.md); the READ method
// (List) backs the read-only UI.
package testcovers

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

CREATE TABLE IF NOT EXISTS test_covers (
  repo           TEXT    NOT NULL DEFAULT '',  -- canonical repo string: '' = the primary repo
  pr             INTEGER NOT NULL,
  test_id        TEXT    NOT NULL,
  target_key     TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  covered_file   TEXT    NOT NULL DEFAULT '',
  covered_class  TEXT    NOT NULL DEFAULT '',
  covered_method TEXT    NOT NULL DEFAULT '',
  covered_line   INTEGER NOT NULL DEFAULT 0,
  covered_code   TEXT    NOT NULL DEFAULT '',
  annotation     TEXT    NOT NULL DEFAULT '',
  model          TEXT    NOT NULL DEFAULT '',
  confidence     TEXT    NOT NULL DEFAULT '',
  updated_at     TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (pr, test_id, target_key)
);

CREATE INDEX IF NOT EXISTS idx_test_covers_pr ON test_covers(pr);
`

// migrate adds columns introduced after the first schema so an existing
// testcovers.db picks them up. CREATE TABLE IF NOT EXISTS never alters an
// existing table, so the line column needs an explicit ADD; a
// duplicate-column error just means the DB is already up to date.
func migrate(db *sql.DB) {
	_, _ = db.Exec(`ALTER TABLE test_covers ADD COLUMN line INTEGER NOT NULL DEFAULT 0`)
	// Multi-repo (see repos.go): existing rows are the primary repo's, which IS the
	// '' default. The PK stays (pr, test_id, target_key) — a test id already
	// carries a non-primary repo's key.
	_, _ = db.Exec(`ALTER TABLE test_covers ADD COLUMN repo TEXT NOT NULL DEFAULT ''`)
	// Only after the column is guaranteed to exist (see the note in the schema).
	_, _ = db.Exec(`CREATE INDEX IF NOT EXISTS idx_test_covers_pr_repo ON test_covers(repo, pr)`)
}

// Status values.
const (
	StatusResolved    = "resolved"    // a method-level annotation, verified statically
	StatusUnannotated = "unannotated" // no annotation at all — warning, never AI
	StatusUnresolved  = "unresolved"  // a class-level-only annotation — offer the LLM search
	StatusSearching   = "searching"   // a resolve_test_covers LLM run is in progress
	StatusFound       = "found"       // an LLM run found the covered method
	StatusNotfound    = "notfound"    // an LLM run could not find it either
)

// Model values recorded on LLM-produced rows.
const (
	ModelHaiku  = "haiku"
	ModelSonnet = "sonnet"
)

// Entry is one test → covered-method resolution.
type Entry struct {
	// Repo is the canonical repo string ("" = the primary repo, see repos.go).
	Repo          string `json:"repo,omitempty"`
	PR            int    `json:"pr"`
	TestID        string `json:"testId"`
	TargetKey     string `json:"targetKey"`
	Status        string `json:"status"`
	CoveredFile   string `json:"coveredFile"`
	CoveredClass  string `json:"coveredClass"`
	CoveredMethod string `json:"coveredMethod"`
	CoveredLine   int    `json:"coveredLine"`
	CoveredCode   string `json:"coveredCode"`
	Annotation    string `json:"annotation"`
	Model         string `json:"model"`
	Confidence    string `json:"confidence"`
	UpdatedAt     string `json:"updatedAt"`
	// Line is the absolute source line, within the TEST's own file, where the
	// coverage annotation sits (see testcovers_analysis.go's coverTarget.line)
	// — distinct from CoveredLine (the covered production method's own
	// declaration line). Used by the frontend to scope/reorder the
	// "Onderliggende code" panel by the reviewer's selected group/line
	// (detail-layout.md). Set on a Go-produced `resolved`/`unresolved` row
	// whose annotation sits directly above the TEST METHOD ITSELF (the
	// annotation genuinely lives in that one test's own text). Left 0 for two
	// distinct cases that both degrade to the same "not in scope" bucket as
	// `covered_by` (see src/home.mjs's relatedChildren): an LLM-resolved
	// `found` row (escalated from an `unresolved` class-only annotation),
	// which does not carry it forward — see resolve_test_covers.go — and a
	// Go-`resolved` row whose annotation instead sits above the CLASS
	// (testcovers_analysis.go's coverTargets, the classZoneText fallback) —
	// that line is shared verbatim by every test method in the file, so it is
	// never "this test's own line" either.
	Line int `json:"line"`
}

// Module owns the test-coverage store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the testcovers DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", sqlitedsn.DSN(path))
	if err != nil {
		return nil, fmt.Errorf("testcovers: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("testcovers: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("testcovers: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// UpsertGo writes the static analyzer's entries (status resolved/unannotated/
// unresolved) for a PR. It does NOT clobber a row already owned by the LLM
// (status searching/found/notfound) — a Go rebuild must not wipe an expensive
// LLM resolution. WRITE — workflow-Activity-only. Idempotent per (pr, test_id,
// target_key).
func (m *Module) UpsertGo(ctx context.Context, entries []Entry) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
INSERT INTO test_covers
  (repo, pr, test_id, target_key, status, covered_file, covered_class, covered_method, covered_line, covered_code, annotation, model, confidence, updated_at, line)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(pr, test_id, target_key) DO UPDATE SET
  status         = excluded.status,
  covered_file   = excluded.covered_file,
  covered_class  = excluded.covered_class,
  covered_method = excluded.covered_method,
  covered_line   = excluded.covered_line,
  covered_code   = excluded.covered_code,
  annotation     = excluded.annotation,
  model          = excluded.model,
  confidence     = excluded.confidence,
  updated_at     = excluded.updated_at,
  line           = excluded.line
WHERE test_covers.status NOT IN ('searching','found','notfound')`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, e := range entries {
		if _, err := stmt.ExecContext(ctx,
			e.Repo, e.PR, e.TestID, e.TargetKey, e.Status,
			e.CoveredFile, e.CoveredClass, e.CoveredMethod, e.CoveredLine, e.CoveredCode,
			e.Annotation, e.Model, e.Confidence, now(), e.Line); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Prune deletes every entry for pr whose (test_id, target_key) is not among
// keep — the pairs the Go scan just emitted. A pair goes stale when its test
// block left the PR (re-ingest dropped the file) or its annotation was
// removed/changed; either way the row — LLM-owned included — is meaningless.
// WRITE — workflow-Activity-only.
func (m *Module) Prune(ctx context.Context, repo string, pr int, keep []Entry) error {
	if len(keep) == 0 {
		_, err := m.db.ExecContext(ctx, `DELETE FROM test_covers WHERE repo = ? AND pr = ?`, repo, pr)
		return err
	}
	const sep = "\x1f"
	args := make([]any, 0, len(keep)+2)
	args = append(args, repo, pr)
	ph := make([]string, len(keep))
	for i, e := range keep {
		ph[i] = "?"
		args = append(args, e.TestID+sep+e.TargetKey)
	}
	q := `DELETE FROM test_covers WHERE repo = ? AND pr = ? AND test_id || char(31) || target_key NOT IN (` +
		strings.Join(ph, ",") + `)`
	_, err := m.db.ExecContext(ctx, q, args...)
	return err
}

// Purge removes every test-coverage row of pr — unlike Prune, unconditional
// (no keep set): the whole PR is being retired. WRITE — workflow-only, the
// per-PR data-retention cleanup path (see the cleanup workflow). Returns the
// number of rows removed, for logging.
func (m *Module) Purge(ctx context.Context, repo string, pr int) (int64, error) {
	res, err := m.db.ExecContext(ctx, `DELETE FROM test_covers WHERE repo = ? AND pr = ?`, repo, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// SaveSearching marks the given targets of a test as being searched by the
// LLM. WRITE — workflow-Activity-only.
func (m *Module) SaveSearching(ctx context.Context, repo string, pr int, testID string, targetKeys []string) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `
INSERT INTO test_covers (repo, pr, test_id, target_key, status, updated_at)
VALUES (?,?,?,?,?,?)
ON CONFLICT(pr, test_id, target_key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, k := range targetKeys {
		if _, err := stmt.ExecContext(ctx, repo, pr, testID, k, StatusSearching, now()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Save upserts one LLM-produced resolution (found or notfound). WRITE —
// workflow-Activity-only.
func (m *Module) Save(ctx context.Context, e Entry) error {
	_, err := m.db.ExecContext(ctx, `
INSERT OR REPLACE INTO test_covers
  (repo, pr, test_id, target_key, status, covered_file, covered_class, covered_method, covered_line, covered_code, annotation, model, confidence, updated_at, line)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.Repo, e.PR, e.TestID, e.TargetKey, e.Status,
		e.CoveredFile, e.CoveredClass, e.CoveredMethod, e.CoveredLine, e.CoveredCode,
		e.Annotation, e.Model, e.Confidence, now(), e.Line)
	return err
}

// List returns all test-coverage entries for a PR, ordered deterministically.
// READ — safe for the UI/API.
func (m *Module) List(ctx context.Context, repo string, pr int) ([]Entry, error) {
	rows, err := m.db.QueryContext(ctx, `
SELECT repo, pr, test_id, target_key, status, covered_file, covered_class, covered_method, covered_line, covered_code, annotation, model, confidence, updated_at, line
FROM test_covers WHERE repo = ? AND pr = ? ORDER BY test_id, target_key`, repo, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.Repo, &e.PR, &e.TestID, &e.TargetKey, &e.Status,
			&e.CoveredFile, &e.CoveredClass, &e.CoveredMethod, &e.CoveredLine, &e.CoveredCode,
			&e.Annotation, &e.Model, &e.Confidence, &e.UpdatedAt, &e.Line); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
