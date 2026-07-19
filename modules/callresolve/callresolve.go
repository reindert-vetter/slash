// Package callresolve is the call-resolution module/service: a SQLite read-model
// that couples a call site inside a changed block (its caller block ID + the
// called symbol) to the definition of the called method — even when that method
// lives in a file the PR did NOT change. It backs the "Onderliggende code" panel
// alongside the relations module.
//
// It deliberately lives outside the relations table because its children point
// at UNCHANGED files (so their block IDs are not PR blocks the frontend knows)
// and because relations.Replace full-swaps per PR on every build — an expensive
// LLM resolution would be wiped by a rebuild. Rows here carry the full child
// descriptor plus the code text, and the LLM-owned states (searching/found) are
// preserved across Go rebuilds (see UpsertGo).
//
// WRITE methods (UpsertGo/SaveSearching/SaveFound/SaveNotfound) are driven only
// by workflow Activities (per .claude/rules/workflows-write-boundary.md); the
// READ method (List) backs the read-only UI.
package callresolve

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

CREATE TABLE IF NOT EXISTS call_resolutions (
  pr           INTEGER NOT NULL,
  caller_id    TEXT    NOT NULL,
  call_key     TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'method_call',
  child_file   TEXT    NOT NULL DEFAULT '',
  child_class  TEXT    NOT NULL DEFAULT '',
  child_method TEXT    NOT NULL DEFAULT '',
  child_line   INTEGER NOT NULL DEFAULT 0,
  child_code   TEXT    NOT NULL DEFAULT '',
  model        TEXT    NOT NULL DEFAULT '',
  confidence   TEXT    NOT NULL DEFAULT '',
  updated_at   TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (pr, caller_id, call_key)
);

CREATE INDEX IF NOT EXISTS idx_call_resolutions_pr ON call_resolutions(pr);
`

// migrate adds columns introduced after the first schema so an existing
// callresolve.db picks them up. CREATE TABLE IF NOT EXISTS never alters an
// existing table, so the kind column needs an explicit ADD; a
// duplicate-column error just means the DB is already up to date.
func migrate(db *sql.DB) {
	_, _ = db.Exec(`ALTER TABLE call_resolutions ADD COLUMN kind TEXT NOT NULL DEFAULT 'method_call'`)
}

// Status values.
const (
	StatusResolved   = "resolved"   // Go resolver found the definition
	StatusUnresolved = "unresolved" // Go could not resolve — offer the "Zoek" button
	StatusSearching  = "searching"  // an LLM resolve_call run is in progress
	StatusFound      = "found"      // an LLM run found the definition
	StatusNotfound   = "notfound"   // an LLM run could not find it either
)

// Model values recorded on LLM-produced rows.
const (
	ModelHaiku  = "haiku"
	ModelSonnet = "sonnet"
)

// Kind values name what a resolved row actually points at. The default,
// "method_call", is a call site resolved to a defining method (the original,
// only kind before this column existed) — every existing entry-producing rule
// keeps leaving Kind empty in Go and gets normalized to KindMethodCall at
// write time (see UpsertGo/Save), so only the newer, class-level rules below
// need to set it explicitly.
const (
	KindMethodCall     = "method_call"     // a call site resolved to a defining method (default)
	KindModelUsage     = "model_usage"     // a changed line uses an Eloquent model (new/static) → the model as a whole
	KindMigrationModel = "migration_model" // a changed migration's Schema::create/table → its Eloquent model
)

// Entry is one call-site → definition resolution.
type Entry struct {
	PR          int    `json:"pr"`
	CallerID    string `json:"callerId"`
	CallKey     string `json:"callKey"`
	Status      string `json:"status"`
	Kind        string `json:"kind"`
	ChildFile   string `json:"childFile"`
	ChildClass  string `json:"childClass"`
	ChildMethod string `json:"childMethod"`
	ChildLine   int    `json:"childLine"`
	ChildCode   string `json:"childCode"`
	Model       string `json:"model"`
	Confidence  string `json:"confidence"`
	UpdatedAt   string `json:"updatedAt"`
	// HadCandidates records whether the Go static index had ANY candidate
	// definition for this call at resolution time — not persisted to the DB
	// (no column), it exists only to travel through the resolveWithModel
	// Activity's JSON result so resolveCallWorkflow's escalation decision can
	// read it deterministically from history on replay. See
	// resolveCallsWithModel (resolve_call.go) and resolveCallWorkflow
	// (workflows.go).
	HadCandidates bool `json:"hadCandidates"`
}

// Module owns the call-resolution store.
type Module struct{ db *sql.DB }

// Open opens (or creates) the callresolve DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("callresolve: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("callresolve: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("callresolve: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

func (m *Module) Close() error { return m.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// UpsertGo writes the Go resolver's entries (status resolved/unresolved) for a
// PR. It does NOT clobber a row already owned by the LLM (status searching or
// found) — a Go rebuild must not wipe an expensive LLM resolution. WRITE —
// workflow-Activity-only. Idempotent per (pr, caller_id, call_key).
func (m *Module) UpsertGo(ctx context.Context, entries []Entry) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
INSERT INTO call_resolutions
  (pr, caller_id, call_key, status, kind, child_file, child_class, child_method, child_line, child_code, model, confidence, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(pr, caller_id, call_key) DO UPDATE SET
  status       = excluded.status,
  kind         = excluded.kind,
  child_file   = excluded.child_file,
  child_class  = excluded.child_class,
  child_method = excluded.child_method,
  child_line   = excluded.child_line,
  child_code   = excluded.child_code,
  model        = excluded.model,
  confidence   = excluded.confidence,
  updated_at   = excluded.updated_at
WHERE call_resolutions.status NOT IN ('searching','found')`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, e := range entries {
		kind := e.Kind
		if kind == "" {
			kind = KindMethodCall
		}
		if _, err := stmt.ExecContext(ctx,
			e.PR, e.CallerID, e.CallKey, e.Status, kind,
			e.ChildFile, e.ChildClass, e.ChildMethod, e.ChildLine, e.ChildCode,
			e.Model, e.Confidence, now()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Prune deletes every resolution for pr whose (caller_id, call_key) pair is not
// among keep — the pairs the Go scan just emitted. A pair goes stale when its
// caller block left the PR (re-ingest dropped the file) or when its call site is
// no longer on a changed line; either way the row — LLM-owned included, its call
// site is gone — is meaningless. WRITE — workflow-Activity-only.
func (m *Module) Prune(ctx context.Context, pr int, keep []Entry) error {
	if len(keep) == 0 {
		_, err := m.db.ExecContext(ctx, `DELETE FROM call_resolutions WHERE pr = ?`, pr)
		return err
	}
	// Pair the PK columns with a separator that appears in neither.
	const sep = "\x1f"
	args := make([]any, 0, len(keep)+1)
	args = append(args, pr)
	ph := make([]string, len(keep))
	for i, e := range keep {
		ph[i] = "?"
		args = append(args, e.CallerID+sep+e.CallKey)
	}
	q := `DELETE FROM call_resolutions WHERE pr = ? AND caller_id || char(31) || call_key NOT IN (` +
		strings.Join(ph, ",") + `)`
	_, err := m.db.ExecContext(ctx, q, args...)
	return err
}

// SaveSearching marks the given calls of a caller as in-progress. WRITE —
// workflow-Activity-only.
func (m *Module) SaveSearching(ctx context.Context, pr int, callerID string, calls []string) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `
INSERT INTO call_resolutions (pr, caller_id, call_key, status, updated_at)
VALUES (?,?,?,?,?)
ON CONFLICT(pr, caller_id, call_key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, c := range calls {
		if _, err := stmt.ExecContext(ctx, pr, callerID, c, StatusSearching, now()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Save upserts one LLM-produced resolution (found or notfound). WRITE —
// workflow-Activity-only.
func (m *Module) Save(ctx context.Context, e Entry) error {
	kind := e.Kind
	if kind == "" {
		kind = KindMethodCall
	}
	_, err := m.db.ExecContext(ctx, `
INSERT OR REPLACE INTO call_resolutions
  (pr, caller_id, call_key, status, kind, child_file, child_class, child_method, child_line, child_code, model, confidence, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.PR, e.CallerID, e.CallKey, e.Status, kind,
		e.ChildFile, e.ChildClass, e.ChildMethod, e.ChildLine, e.ChildCode,
		e.Model, e.Confidence, now())
	return err
}

// List returns all resolutions for a PR, ordered deterministically. READ — safe
// for the UI/API.
func (m *Module) List(ctx context.Context, pr int) ([]Entry, error) {
	rows, err := m.db.QueryContext(ctx, `
SELECT pr, caller_id, call_key, status, kind, child_file, child_class, child_method, child_line, child_code, model, confidence, updated_at
FROM call_resolutions WHERE pr = ? ORDER BY caller_id, call_key`, pr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.PR, &e.CallerID, &e.CallKey, &e.Status, &e.Kind,
			&e.ChildFile, &e.ChildClass, &e.ChildMethod, &e.ChildLine, &e.ChildCode,
			&e.Model, &e.Confidence, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// NormalizeCallKey trims a captured call token to its bare method name (e.g.
// "->joinAddress" or "joinAddress(" → "joinAddress"), so a call site keys
// stably regardless of how it was captured.
func NormalizeCallKey(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "->")
	s = strings.TrimPrefix(s, "::")
	if i := strings.IndexAny(s, "("); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}
