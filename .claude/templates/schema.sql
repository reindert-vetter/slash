-- Template: SQLite schema for the PR Review Tree's call graph.
-- Applied via database/sql + modernc.org/sqlite. Keep it small and normalized
-- so an update to a single function or a single edge is one row mutation.

PRAGMA journal_mode = WAL;   -- better concurrency for read-while-write
PRAGMA foreign_keys = ON;

-- One function/method in the graph = one "block" from a PR diff.
CREATE TABLE IF NOT EXISTS blocks (
  id         TEXT PRIMARY KEY,          -- "<pr>:<file>:<Class::method>"
  name       TEXT NOT NULL,             -- symbol (method/function) or file name as fallback
  class      TEXT NOT NULL DEFAULT '',  -- '' for free functions / whole-file fallback
  file       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',  -- ACTION|CONTROLLER|MODEL|MIGRATION|TEST|...
  line       INTEGER NOT NULL,          -- declaration line
  end_line   INTEGER NOT NULL DEFAULT 0,-- line of the closing brace
  status     TEXT NOT NULL DEFAULT '',  -- added|removed|modified
  file_deleted INTEGER NOT NULL DEFAULT 0, -- 0/1: the WHOLE file was removed by the PR
                                           -- (absent in the head worktree, git's "+++ /dev/null")
  old_file   TEXT NOT NULL DEFAULT '',   -- pre-rename path if the PR moved this block's file
                                          -- (git-detected rename); '' otherwise. file stays the NEW path
  side       TEXT NOT NULL DEFAULT 'new',-- new|old: which worktree line/end_line refer to
  pr         INTEGER NOT NULL DEFAULT 0, -- PR number this block belongs to
  approved   INTEGER NOT NULL DEFAULT 0, -- 0/1: approved by the reviewer?
  description TEXT NOT NULL DEFAULT ''   -- free text from a PHPDoc /** ... */ directly above the
                                          -- declaration (@tags stripped); deterministic, no AI
);

-- A call: caller -> callee.
CREATE TABLE IF NOT EXISTS edges (
  caller_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  callee_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  PRIMARY KEY (caller_id, callee_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_id);
CREATE INDEX IF NOT EXISTS idx_blocks_approved ON blocks(approved);
CREATE INDEX IF NOT EXISTS idx_blocks_pr ON blocks(pr);
CREATE INDEX IF NOT EXISTS idx_blocks_pr_status ON blocks(pr, status);

-- pr_ingest remembers the base/head SHA that a PR's blocks table was last
-- filled from. The ingest refresh (pr_status's SignalPRState branch, see
-- refreshIngestDelta) diffs the previously stored head SHA against a newly
-- observed SHA to determine exactly which files changed since then, instead
-- of re-scanning the whole PR on every refresh.
CREATE TABLE IF NOT EXISTS pr_ingest (
  pr       INTEGER PRIMARY KEY,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL
);
