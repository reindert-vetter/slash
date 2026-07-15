-- Template: SQLite-schema voor de call-graph van de PR Review Tree.
-- Toegepast via database/sql + modernc.org/sqlite. Houd het klein en genormaliseerd
-- zodat een update van één functie of één edge een enkele row-mutatie is.

PRAGMA journal_mode = WAL;   -- betere concurrency voor lees-tijdens-schrijf
PRAGMA foreign_keys = ON;

-- Eén functie/method in de graph = één "block" uit een PR-diff.
CREATE TABLE IF NOT EXISTS blocks (
  id         TEXT PRIMARY KEY,          -- "<pr>:<file>:<Class::method>"
  name       TEXT NOT NULL,             -- symbool (method/functie) of bestandsnaam bij fallback
  class      TEXT NOT NULL DEFAULT '',  -- '' voor vrije functies / whole-file fallback
  file       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',  -- ACTION|CONTROLLER|MODEL|MIGRATION|TEST|...
  line       INTEGER NOT NULL,          -- declaratieregel
  end_line   INTEGER NOT NULL DEFAULT 0,-- regel van de sluitende brace
  status     TEXT NOT NULL DEFAULT '',  -- added|removed|modified
  side       TEXT NOT NULL DEFAULT 'new',-- new|old: welke worktree line/end_line duiden
  pr         INTEGER NOT NULL DEFAULT 0, -- PR-nummer waar dit block bij hoort
  approved   INTEGER NOT NULL DEFAULT 0  -- 0/1: door de reviewer goedgekeurd?
);

-- Een aanroep: caller -> callee.
CREATE TABLE IF NOT EXISTS edges (
  caller_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  callee_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  PRIMARY KEY (caller_id, callee_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_id);
CREATE INDEX IF NOT EXISTS idx_blocks_approved ON blocks(approved);
CREATE INDEX IF NOT EXISTS idx_blocks_pr ON blocks(pr);
CREATE INDEX IF NOT EXISTS idx_blocks_pr_status ON blocks(pr, status);

-- pr_ingest onthoudt de base/head-SHA waar de blocks-tabel van een PR het
-- laatst mee is gevuld. De ingest-refresh (pr_status's SignalPRState-tak, zie
-- refreshIngestDelta) diff't de eerder opgeslagen head-SHA tegen een nieuw
-- waargenomen SHA om precies te bepalen welke bestanden sindsdien wijzigden,
-- i.p.v. de hele PR opnieuw te scannen bij elke refresh.
CREATE TABLE IF NOT EXISTS pr_ingest (
  pr       INTEGER PRIMARY KEY,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL
);
