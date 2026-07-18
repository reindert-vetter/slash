package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"slash/modules/callresolve"
	"slash/modules/explanations"
	"slash/modules/relations"
	"slash/modules/testcovers"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "ingest":
			runIngestCmd(os.Args[2:])
			return
		case "seed":
			runSeedCmd(os.Args[2:])
			return
		case "relations":
			runRelationsCmd(os.Args[2:])
			return
		}
	}
	runServe(os.Args[1:])
}

// dbPath resolves the DB path from a flag value, falling back to SLASH_DB then
// a default.
func dbPath(flagVal string) string {
	if flagVal != "" {
		return flagVal
	}
	if env := os.Getenv("SLASH_DB"); env != "" {
		return env
	}
	return "data/graph.db"
}

// runServe starts the HTTP server (default command).
func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	dbFlag := fs.String("db", "", "path to the SQLite DB (or SLASH_DB env)")
	addr := fs.String("addr", "127.0.0.1:8765", "listen address")
	staticDir := fs.String("static", ".", "directory served statically")
	_ = fs.Parse(args)

	if err := os.MkdirAll("data", 0o755); err != nil {
		log.Fatalf("mkdir data: %v", err)
	}
	resolvedDB := dbPath(*dbFlag)
	db, err := openDB(resolvedDB)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	// Workflow/comments stores live next to the DB, so a test DB isolates its
	// workflow state too. (The worktree data dir stays "data" — see server.)
	tk, closeTasks, err := newTasks(context.Background(), db, filepath.Dir(resolvedDB), repoSlug, true)
	if err != nil {
		log.Fatalf("init workflows: %v", err)
	}
	defer closeTasks()

	srv := &server{db: db, dataDir: "data", tasks: tk}
	log.Printf("PR Review Tree listening on http://%s", *addr)
	if err := http.ListenAndServe(*addr, srv.routes(*staticDir)); err != nil {
		log.Fatal(err)
	}
}

// runIngestCmd runs the ingest pipeline headless: `slash ingest <pr> [-db path]`.
func runIngestCmd(args []string) {
	fs := flag.NewFlagSet("ingest", flag.ExitOnError)
	dbFlag := fs.String("db", "", "path to the SQLite DB (or SLASH_DB env)")
	_ = fs.Parse(args)

	rest := fs.Args()
	if len(rest) < 1 {
		log.Fatal("usage: slash ingest <pr> [-db path]")
	}
	var pr int
	if _, err := fmt.Sscan(rest[0], &pr); err != nil || pr <= 0 {
		log.Fatalf("invalid pr: %q", rest[0])
	}

	if err := os.MkdirAll("data", 0o755); err != nil {
		log.Fatalf("mkdir data: %v", err)
	}
	resolvedDB := dbPath(*dbFlag)
	db, err := openDB(resolvedDB)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	// Build the workflow engine (no server runtime — no poller resume, no inbox
	// fetch) just to run the ingest workflow, the sole writer of blocks/worktrees.
	dataDir := filepath.Dir(resolvedDB)
	tk, closeTasks, err := newTasks(context.Background(), db, dataDir, repoSlug, false)
	if err != nil {
		log.Fatalf("init workflows: %v", err)
	}
	defer closeTasks()

	ctx, cancel := context.WithTimeout(context.Background(), ingestTimeout)
	defer cancel()
	res, err := tk.manager.StartIngest(ctx, pr)
	if err != nil {
		log.Fatalf("ingest: %v", err)
	}
	tk.manager.EnsureRelations(ctx, pr)
	out, _ := json.MarshalIndent(res, "", "  ")
	fmt.Println(string(out))
}

// runRelationsCmd re-runs the block-relation detectors for a PR against the
// already-ingested blocks + head worktree, persists them into relations.db, and
// prints what it found: `slash relations <pr> [-db path]`. Headless twin of the
// build_relations workflow's Activity — handy to re-derive relations without a
// full re-ingest.
func runRelationsCmd(args []string) {
	fs := flag.NewFlagSet("relations", flag.ExitOnError)
	dbFlag := fs.String("db", "", "path to the SQLite DB (or SLASH_DB env)")
	_ = fs.Parse(args)

	rest := fs.Args()
	if len(rest) < 1 {
		log.Fatal("usage: slash relations <pr> [-db path]")
	}
	var pr int
	if _, err := fmt.Sscan(rest[0], &pr); err != nil || pr <= 0 {
		log.Fatalf("invalid pr: %q", rest[0])
	}

	resolvedDB := dbPath(*dbFlag)
	dataDir := filepath.Dir(resolvedDB)
	db, err := openDB(resolvedDB)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	blocks, err := blocksByPR(db, pr)
	if err != nil {
		log.Fatalf("load blocks: %v", err)
	}
	rels := buildRelations(dataDir, pr, blocks)

	rel, err := relations.Open(filepath.Join(dataDir, "relations.db"))
	if err != nil {
		log.Fatalf("open relations db: %v", err)
	}
	defer rel.Close()
	if err := rel.Replace(context.Background(), pr, rels); err != nil {
		log.Fatalf("save relations: %v", err)
	}

	// Mirror the build_relations Activity: also resolve the blocks' method calls
	// into the callresolve read-model, so a headless re-run refreshes the
	// Onderliggende-code panel too (UpsertGo preserves LLM-owned rows, Prune drops
	// call-sites that fell out of the PR).
	calls := resolveCalls(dataDir, pr, blocks)
	cr, err := callresolve.Open(filepath.Join(dataDir, "callresolve.db"))
	if err != nil {
		log.Fatalf("open callresolve db: %v", err)
	}
	defer cr.Close()
	if err := cr.UpsertGo(context.Background(), calls); err != nil {
		log.Fatalf("save call resolutions: %v", err)
	}
	if err := cr.Prune(context.Background(), pr, calls); err != nil {
		log.Fatalf("prune call resolutions: %v", err)
	}

	// Also detect test-coverage annotations, mirroring the buildRelations
	// Activity's third step (Go rows only — UpsertGo preserves any LLM-owned
	// searching/found/notfound row from a prior resolve_test_covers run).
	covers := scanTestCovers(dataDir, pr, blocks)
	tc, err := testcovers.Open(filepath.Join(dataDir, "testcovers.db"))
	if err != nil {
		log.Fatalf("open testcovers db: %v", err)
	}
	defer tc.Close()
	if err := tc.UpsertGo(context.Background(), covers); err != nil {
		log.Fatalf("save test covers: %v", err)
	}
	if err := tc.Prune(context.Background(), pr, covers); err != nil {
		log.Fatalf("prune test covers: %v", err)
	}

	label := map[string]string{}
	for _, b := range blocks {
		label[b.ID()] = b.Label
	}
	fmt.Printf("PR %d: %d block(s), %d relation(s), %d call(s) resolved, %d test-cover(s)\n", pr, len(blocks), len(rels), len(calls), len(covers))
	for _, r := range rels {
		fmt.Printf("  [%s] %s  →  %s\n", r.Kind, label[r.ParentID], label[r.ChildID])
	}
}

// runSeedCmd loads blocks from a JSON fixture into a DB (no network) for tests:
// `slash seed -db <path> -from <blocks.json>`.
func runSeedCmd(args []string) {
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	dbFlag := fs.String("db", "", "path to the SQLite DB to seed")
	from := fs.String("from", "", "path to a blocks JSON fixture")
	relFrom := fs.String("relations", "", "optional path to a relations JSON fixture (seeded into relations.db)")
	crFrom := fs.String("callresolve", "", "optional path to a call-resolutions JSON fixture (seeded into callresolve.db)")
	tcFrom := fs.String("testcovers", "", "optional path to a test-coverage JSON fixture (seeded into testcovers.db)")
	exFrom := fs.String("explanations", "", "optional path to an AI-explanations JSON fixture (seeded into explanations.db)")
	_ = fs.Parse(args)

	if *from == "" {
		log.Fatal("usage: slash seed -db <path> -from <blocks.json> [-relations <relations.json>] [-callresolve <callresolve.json>] [-testcovers <testcovers.json>] [-explanations <explanations.json>]")
	}
	raw, err := os.ReadFile(*from)
	if err != nil {
		log.Fatalf("read fixture: %v", err)
	}
	var blocks []Block
	if err := json.Unmarshal(raw, &blocks); err != nil {
		log.Fatalf("parse fixture: %v", err)
	}

	db, err := openDB(dbPath(*dbFlag))
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	// Group by PR so each PR is a clean replace.
	byPR := map[int][]Block{}
	for _, b := range blocks {
		byPR[b.PR] = append(byPR[b.PR], b)
	}
	for pr, bs := range byPR {
		if err := replacePRBlocks(db, pr, bs); err != nil {
			log.Fatalf("seed pr %d: %v", pr, err)
		}
	}
	log.Printf("seeded %d blocks from %s", len(blocks), *from)

	if *relFrom != "" {
		seedRelations(dbPath(*dbFlag), *relFrom)
	}
	if *crFrom != "" {
		seedCallResolve(dbPath(*dbFlag), *crFrom)
	}
	if *tcFrom != "" {
		seedTestCovers(dbPath(*dbFlag), *tcFrom)
	}
	if *exFrom != "" {
		seedExplanations(dbPath(*dbFlag), *exFrom)
	}
}

// seedExplanations loads AI unit-explanations from a JSON fixture into the
// explanations.db next to the blocks DB, so tests can render the footer's
// AI description without an LLM run. A fixture row with an empty codeHash
// matches any hash on the frontend (see loadExplanations in home.mjs).
func seedExplanations(dbPath, from string) {
	raw, err := os.ReadFile(from)
	if err != nil {
		log.Fatalf("read explanations fixture: %v", err)
	}
	var entries []explanations.Entry
	if err := json.Unmarshal(raw, &entries); err != nil {
		log.Fatalf("parse explanations fixture: %v", err)
	}
	ex, err := explanations.Open(filepath.Join(filepath.Dir(dbPath), "explanations.db"))
	if err != nil {
		log.Fatalf("open explanations db: %v", err)
	}
	defer ex.Close()

	ctx := context.Background()
	for _, e := range entries {
		if err := ex.Save(ctx, e); err != nil {
			log.Fatalf("seed explanations %s/%s: %v", e.BlockID, e.UnitKey, err)
		}
	}
	log.Printf("seeded %d explanations from %s", len(entries), from)
}

// seedTestCovers loads test-coverage entries from a JSON fixture into the
// testcovers.db next to the blocks DB, so tests can render both directions of
// the "Onderliggende code" panel's test-coverage children (and the warning
// variants) without a real annotation scan/LLM run.
func seedTestCovers(dbPath, from string) {
	raw, err := os.ReadFile(from)
	if err != nil {
		log.Fatalf("read testcovers fixture: %v", err)
	}
	var entries []testcovers.Entry
	if err := json.Unmarshal(raw, &entries); err != nil {
		log.Fatalf("parse testcovers fixture: %v", err)
	}
	tc, err := testcovers.Open(filepath.Join(filepath.Dir(dbPath), "testcovers.db"))
	if err != nil {
		log.Fatalf("open testcovers db: %v", err)
	}
	defer tc.Close()

	ctx := context.Background()
	for _, e := range entries {
		if err := tc.Save(ctx, e); err != nil {
			log.Fatalf("seed testcovers %s/%s: %v", e.TestID, e.TargetKey, err)
		}
	}
	log.Printf("seeded %d test-coverage entries from %s", len(entries), from)
}

// seedCallResolve loads call resolutions from a JSON fixture into the
// callresolve.db next to the blocks DB, so tests can render the underlying-code
// panel's method-call children (and exercise its cursor-following) without an
// LLM/Go resolver run.
func seedCallResolve(dbPath, from string) {
	raw, err := os.ReadFile(from)
	if err != nil {
		log.Fatalf("read callresolve fixture: %v", err)
	}
	var entries []callresolve.Entry
	if err := json.Unmarshal(raw, &entries); err != nil {
		log.Fatalf("parse callresolve fixture: %v", err)
	}
	cr, err := callresolve.Open(filepath.Join(filepath.Dir(dbPath), "callresolve.db"))
	if err != nil {
		log.Fatalf("open callresolve db: %v", err)
	}
	defer cr.Close()

	ctx := context.Background()
	for _, e := range entries {
		if err := cr.Save(ctx, e); err != nil {
			log.Fatalf("seed callresolve %s/%s: %v", e.CallerID, e.CallKey, err)
		}
	}
	log.Printf("seeded %d call resolutions from %s", len(entries), from)
}

// seedRelations loads relations from a JSON fixture into the relations.db that
// sits next to the blocks DB (same dataDir the server uses), so tests can render
// nested children without a workflow run.
func seedRelations(dbPath, from string) {
	raw, err := os.ReadFile(from)
	if err != nil {
		log.Fatalf("read relations fixture: %v", err)
	}
	var rels []relations.Relation
	if err := json.Unmarshal(raw, &rels); err != nil {
		log.Fatalf("parse relations fixture: %v", err)
	}
	rel, err := relations.Open(filepath.Join(filepath.Dir(dbPath), "relations.db"))
	if err != nil {
		log.Fatalf("open relations db: %v", err)
	}
	defer rel.Close()

	byPR := map[int][]relations.Relation{}
	for _, r := range rels {
		byPR[r.PR] = append(byPR[r.PR], r)
	}
	ctx := context.Background()
	for pr, rs := range byPR {
		if err := rel.Replace(ctx, pr, rs); err != nil {
			log.Fatalf("seed relations pr %d: %v", pr, err)
		}
	}
	log.Printf("seeded %d relations from %s", len(rels), from)
}
