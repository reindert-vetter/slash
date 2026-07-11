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
	tk, closeTasks, err := newTasks(context.Background(), filepath.Dir(resolvedDB), repoSlug)
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
	db, err := openDB(dbPath(*dbFlag))
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), ingestTimeout)
	defer cancel()
	res, err := ingestPR(ctx, db, "data", pr)
	if err != nil {
		log.Fatalf("ingest: %v", err)
	}
	out, _ := json.MarshalIndent(res, "", "  ")
	fmt.Println(string(out))
}

// runSeedCmd loads blocks from a JSON fixture into a DB (no network) for tests:
// `slash seed -db <path> -from <blocks.json>`.
func runSeedCmd(args []string) {
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	dbFlag := fs.String("db", "", "path to the SQLite DB to seed")
	from := fs.String("from", "", "path to a blocks JSON fixture")
	_ = fs.Parse(args)

	if *from == "" {
		log.Fatal("usage: slash seed -db <path> -from <blocks.json>")
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
}
