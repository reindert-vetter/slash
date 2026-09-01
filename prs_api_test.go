package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"slash/modules/prmeta"
)

// TestPRsUpdatedAtIsTheGitHubMoment pins the one field mapping the "Recent
// gegenereerd" drawer gets wrong the moment it reads prmeta's own UpdatedAt:
// that column is the LOCAL write time of the prmeta row (bumped by every later
// upsert), while the drawer's "Bijgewerkt … geleden" must name the same moment
// the inbox row right above it names — the PR's own GitHub updatedAt. A row
// stored before gh_updated_at existed still falls back to the local time.
func TestPRsUpdatedAtIsTheGitHubMoment(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	pm, err := prmeta.Open(filepath.Join(dir, "prmeta.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer pm.Close()

	ctx := context.Background()
	const ghMoment = "2026-09-01T11:21:23Z"
	for _, pr := range []int{41, 42} {
		block := Block{PR: pr, File: "app/A.php", Class: "A", Name: "x", Line: 3, EndLine: 6,
			Status: StatusModified, Side: SideNew}
		if err := replacePRBlocks(db, "", pr, []Block{block}); err != nil {
			t.Fatal(err)
		}
		// SaveBasics only ever writes updated_at (the local write time).
		if err := pm.SaveBasics(ctx, prmeta.Meta{PR: pr, Title: "PR"}); err != nil {
			t.Fatal(err)
		}
	}
	// Only 42 got as far as the pr_status stage that records gh_updated_at.
	if err := pm.SaveSinceMark(ctx, "", 42, "", "", ghMoment); err != nil {
		t.Fatal(err)
	}

	s := &server{db: db, tasks: &tasks{prmeta: pm}}
	rec := httptest.NewRecorder()
	s.handlePRs(rec, httptest.NewRequest(http.MethodGet, "/api/prs", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var got []PRSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	byPR := map[int]PRSummary{}
	for _, r := range got {
		byPR[r.PR] = r
	}
	if byPR[42].UpdatedAt != ghMoment {
		t.Errorf("PR 42: want the GitHub updatedAt %q, got %q (the local prmeta write time?)", ghMoment, byPR[42].UpdatedAt)
	}
	if byPR[41].UpdatedAt == "" || byPR[41].UpdatedAt == ghMoment {
		t.Errorf("PR 41: want the local write time as fallback, got %q", byPR[41].UpdatedAt)
	}
}
