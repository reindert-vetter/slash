// Package prmeta is the PR-metadata module/service: a small SQLite read-model of
// per-PR facts that the pr_status workflow fills in three stages (basics →
// Claude summary → review/CI statuses), so the UI can render progressively.
// Its WRITE methods (SaveBasics/SaveSummary/SaveStatuses) are driven only by a
// workflow Activity (per the project rule: only workflows mutate state); its
// READ method (Get) backs the read-only UI.
package prmeta

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

CREATE TABLE IF NOT EXISTS pr_meta (
  pr               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  url              TEXT NOT NULL DEFAULT '',
  body             TEXT NOT NULL DEFAULT '',
  author           TEXT NOT NULL DEFAULT '',
  additions        INTEGER NOT NULL DEFAULT 0,
  deletions        INTEGER NOT NULL DEFAULT 0,
  changed_files    INTEGER NOT NULL DEFAULT 0,
  head_ref         TEXT NOT NULL DEFAULT '',
  summary          TEXT NOT NULL DEFAULT '',
  jira_key         TEXT NOT NULL DEFAULT '',
  jira_title       TEXT NOT NULL DEFAULT '',
  jira_desc        TEXT NOT NULL DEFAULT '',
  jira_url         TEXT NOT NULL DEFAULT '',
  review_decision  TEXT NOT NULL DEFAULT '',
  checks_total     INTEGER NOT NULL DEFAULT 0,
  checks_passed    INTEGER NOT NULL DEFAULT 0,
  reviewers        TEXT NOT NULL DEFAULT '[]',
  updated_at       TEXT NOT NULL DEFAULT '',
  gh_updated_at    TEXT NOT NULL DEFAULT '',
  new_since_kind   TEXT NOT NULL DEFAULT '',
  new_since_at     TEXT NOT NULL DEFAULT '',
  since_facts      TEXT NOT NULL DEFAULT '',
  since_summary    TEXT NOT NULL DEFAULT ''
);
`

// Meta is the stored metadata of one PR.
type Meta struct {
	PR             int      `json:"pr"`
	Title          string   `json:"title"`
	URL            string   `json:"url"`
	Body           string   `json:"body"`
	Author         string   `json:"author"`
	Additions      int      `json:"additions"`
	Deletions      int      `json:"deletions"`
	ChangedFiles   int      `json:"changedFiles"`
	HeadRef        string   `json:"headRef"`
	Summary        string   `json:"summary"`
	JiraKey        string   `json:"jiraKey"`
	JiraTitle      string   `json:"jiraTitle"`
	JiraDesc       string   `json:"jiraDesc"`
	JiraURL        string   `json:"jiraUrl"`
	ReviewDecision string   `json:"reviewDecision"`
	ChecksTotal    int      `json:"checksTotal"`
	ChecksPassed   int      `json:"checksPassed"`
	Reviewers      []string `json:"reviewers"`
	UpdatedAt      string   `json:"updatedAt"`
	// GhUpdatedAt is the PR's own GitHub updatedAt — deliberately NOT the same
	// as UpdatedAt above, which is the local write time of this row. It backs
	// the "Bijgewerkt … geleden" line the review tree repeats from the PR
	// overview.
	GhUpdatedAt string `json:"ghUpdatedAt"`
	// NewSinceKind/NewSinceAt mirror the overview's "nieuw sinds jouw
	// review|comment" signal and the moment it refers to (inbox.go's
	// myLastActivity). Both empty means: nothing happened since, or this
	// reviewer never commented/reviewed at all.
	NewSinceKind string `json:"newSinceKind"`
	NewSinceAt   string `json:"newSinceAt"`
	// SinceFacts is a ready-to-render Markdown list of what landed since that
	// moment (commits + touched files), built in Go from the GitHub API —
	// deterministic, always present when there IS something new. SinceSummary
	// is Haiku's prose explanation of those same facts and is best-effort: it
	// can be empty while SinceFacts is not, and the UI then shows the facts
	// alone.
	SinceFacts   string `json:"sinceFacts"`
	SinceSummary string `json:"sinceSummary"`
}

// Module is the prmeta service (owns its own SQLite read-model).
type Module struct{ db *sql.DB }

// Open opens (or creates) the prmeta DB at path and applies the schema.
func Open(path string) (*Module, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("prmeta: open db: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("prmeta: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

// New wraps an existing DB and applies the schema.
func New(db *sql.DB) (*Module, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("prmeta: apply schema: %w", err)
	}
	migrate(db)
	return &Module{db: db}, nil
}

// migrate adds columns introduced after the first schema so an existing
// prmeta.db picks them up. CREATE TABLE IF NOT EXISTS never alters an existing
// table, so these need explicit ADDs; a duplicate-column error just means the
// DB is already up to date (mirrors modules/comments' migrate).
func migrate(db *sql.DB) {
	for _, col := range []string{
		`ALTER TABLE pr_meta ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN author TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN additions INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pr_meta ADD COLUMN deletions INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pr_meta ADD COLUMN changed_files INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pr_meta ADD COLUMN head_ref TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN summary TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN jira_key TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN jira_title TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN jira_desc TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN jira_url TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN review_decision TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN checks_total INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pr_meta ADD COLUMN checks_passed INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pr_meta ADD COLUMN reviewers TEXT NOT NULL DEFAULT '[]'`,
		`ALTER TABLE pr_meta ADD COLUMN gh_updated_at TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN new_since_kind TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN new_since_at TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN since_facts TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pr_meta ADD COLUMN since_summary TEXT NOT NULL DEFAULT ''`,
	} {
		_, _ = db.Exec(col) // ignore "duplicate column name"
	}
}

func (m *Module) Close() error { return m.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// SaveBasics upserts stage 1: title/url/body/author/diff-stats/head-ref plus
// the Jira fields (empty when there's no linked ticket). WRITE — workflow-only.
// Only touches its own columns, so it never clobbers a summary or statuses
// written by a later stage of a previous run.
func (m *Module) SaveBasics(ctx context.Context, meta Meta) error {
	_, err := m.db.ExecContext(ctx, `
		INSERT INTO pr_meta (pr, title, url, body, author, additions, deletions, changed_files, head_ref,
			jira_key, jira_title, jira_desc, jira_url, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(pr) DO UPDATE SET
			title=excluded.title, url=excluded.url, body=excluded.body, author=excluded.author,
			additions=excluded.additions, deletions=excluded.deletions, changed_files=excluded.changed_files,
			head_ref=excluded.head_ref, jira_key=excluded.jira_key, jira_title=excluded.jira_title,
			jira_desc=excluded.jira_desc, jira_url=excluded.jira_url, updated_at=excluded.updated_at`,
		meta.PR, meta.Title, meta.URL, meta.Body, meta.Author, meta.Additions, meta.Deletions,
		meta.ChangedFiles, meta.HeadRef, meta.JiraKey, meta.JiraTitle, meta.JiraDesc, meta.JiraURL, now())
	return err
}

// SaveSummary upserts stage 2: the Claude-generated PR summary. WRITE —
// workflow-only. Only touches the summary + updated_at columns.
func (m *Module) SaveSummary(ctx context.Context, pr int, summary string) error {
	_, err := m.db.ExecContext(ctx, `
		INSERT INTO pr_meta (pr, summary, updated_at) VALUES (?,?,?)
		ON CONFLICT(pr) DO UPDATE SET summary=excluded.summary, updated_at=excluded.updated_at`,
		pr, summary, now())
	return err
}

// SaveStatuses upserts stage 3: review decision + CI checks + reviewers. WRITE
// — workflow-only. Only touches the status columns.
func (m *Module) SaveStatuses(ctx context.Context, pr int, reviewDecision string, checksTotal, checksPassed int, reviewers []string) error {
	if reviewers == nil {
		reviewers = []string{}
	}
	rj, err := json.Marshal(reviewers)
	if err != nil {
		return fmt.Errorf("prmeta: marshal reviewers: %w", err)
	}
	_, err = m.db.ExecContext(ctx, `
		INSERT INTO pr_meta (pr, review_decision, checks_total, checks_passed, reviewers, updated_at)
		VALUES (?,?,?,?,?,?)
		ON CONFLICT(pr) DO UPDATE SET
			review_decision=excluded.review_decision, checks_total=excluded.checks_total,
			checks_passed=excluded.checks_passed, reviewers=excluded.reviewers, updated_at=excluded.updated_at`,
		pr, reviewDecision, checksTotal, checksPassed, string(rj), now())
	return err
}

// SaveSinceMark upserts the "nieuw sinds jouw review|comment" signal of stage
// 3: the kind word, the moment it refers to, and the PR's own GitHub
// updatedAt. WRITE — workflow-only. Only touches its own three columns, so it
// never clobbers a since-summary written by the stage after it.
func (m *Module) SaveSinceMark(ctx context.Context, pr int, kind, at, ghUpdatedAt string) error {
	_, err := m.db.ExecContext(ctx, `
		INSERT INTO pr_meta (pr, new_since_kind, new_since_at, gh_updated_at, updated_at)
		VALUES (?,?,?,?,?)
		ON CONFLICT(pr) DO UPDATE SET
			new_since_kind=excluded.new_since_kind, new_since_at=excluded.new_since_at,
			gh_updated_at=excluded.gh_updated_at, updated_at=excluded.updated_at`,
		pr, kind, at, ghUpdatedAt, now())
	return err
}

// SaveSinceReview upserts stage 4: what changed since the reviewer's own last
// review — the deterministic facts and Haiku's prose explanation of them.
// WRITE — workflow-only. Storing empty strings is meaningful: it is how a PR
// with nothing new (or one this reviewer never reviewed) clears a stale block.
func (m *Module) SaveSinceReview(ctx context.Context, pr int, facts, summary string) error {
	_, err := m.db.ExecContext(ctx, `
		INSERT INTO pr_meta (pr, since_facts, since_summary, updated_at) VALUES (?,?,?,?)
		ON CONFLICT(pr) DO UPDATE SET
			since_facts=excluded.since_facts, since_summary=excluded.since_summary,
			updated_at=excluded.updated_at`,
		pr, facts, summary, now())
	return err
}

// Purge removes the stored pr_meta row of pr, if any. WRITE — workflow-only,
// the per-PR data-retention cleanup path (see the cleanup workflow). Returns
// the number of rows removed (0 or 1), for logging.
func (m *Module) Purge(ctx context.Context, pr int) (int64, error) {
	res, err := m.db.ExecContext(ctx, `DELETE FROM pr_meta WHERE pr = ?`, pr)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Get returns the stored metadata for pr (ok=false when none is stored yet).
// READ — safe for the UI. Fields whose stage hasn't run yet are simply zero
// values, so the UI can render progressively.
func (m *Module) Get(ctx context.Context, pr int) (Meta, bool, error) {
	var meta Meta
	var reviewersJSON string
	err := m.db.QueryRowContext(ctx, `
		SELECT pr, title, url, body, author, additions, deletions, changed_files, head_ref,
			summary, jira_key, jira_title, jira_desc, jira_url,
			review_decision, checks_total, checks_passed, reviewers, updated_at,
			gh_updated_at, new_since_kind, new_since_at, since_facts, since_summary
		FROM pr_meta WHERE pr = ?`, pr).
		Scan(&meta.PR, &meta.Title, &meta.URL, &meta.Body, &meta.Author, &meta.Additions, &meta.Deletions,
			&meta.ChangedFiles, &meta.HeadRef, &meta.Summary, &meta.JiraKey, &meta.JiraTitle, &meta.JiraDesc,
			&meta.JiraURL, &meta.ReviewDecision, &meta.ChecksTotal, &meta.ChecksPassed, &reviewersJSON, &meta.UpdatedAt,
			&meta.GhUpdatedAt, &meta.NewSinceKind, &meta.NewSinceAt, &meta.SinceFacts, &meta.SinceSummary)
	if err == sql.ErrNoRows {
		return Meta{}, false, nil
	}
	if err != nil {
		return Meta{}, false, err
	}
	_ = json.Unmarshal([]byte(reviewersJSON), &meta.Reviewers)
	if meta.Reviewers == nil {
		meta.Reviewers = []string{}
	}
	return meta, true, nil
}
