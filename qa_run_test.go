package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseQAReportTakesTheLastJSONFence(t *testing.T) {
	text := "Voorbeeld:\n```json\n{\"title\":\"oud\",\"steps\":[{\"title\":\"x\"}]}\n```\n" +
		"[slash:qa-step] klaar\nHier het verslag:\n```json\n{\"title\":\"QA: echt\",\"steps\":[{\"title\":\"Stap 1\",\"status\":\"ok\"}]}\n```\n"
	rep, err := parseQAReport(text)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Title != "QA: echt" || len(rep.Steps) != 1 {
		t.Fatalf("got %+v", rep)
	}
	if _, err := parseQAReport("geen verslag"); err == nil {
		t.Fatal("want an error without a json fence")
	}
	if _, err := parseQAReport("```json\n{\"title\":\"x\",\"steps\":[]}\n```"); err == nil {
		t.Fatal("want an error for a report without steps")
	}
}

func TestSanitizeQAReportKeepsOnlyRealPlainImageFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "r1-01-login.png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	rep := &qaReport{Steps: []qaStep{{
		Title:  "Inloggen",
		Status: "WEIRD",
		Images: []qaImage{
			{File: "r1-01-login.png", Caption: "ok"},
			{File: dir + "/r1-01-login.png", Caption: "absolute path is reduced to its name"},
			{File: "missing.png"},
			{File: "../secret.png"},
			{File: "notes.txt"},
		},
	}}}
	sanitizeQAReport(rep, dir)
	st := rep.Steps[0]
	if st.Status != "info" {
		t.Fatalf("unknown status should normalize to info, got %q", st.Status)
	}
	if len(st.Images) != 2 || st.Images[0].File != "r1-01-login.png" || st.Images[1].File != "r1-01-login.png" {
		t.Fatalf("images: %+v", st.Images)
	}
	if rep.Deviations == nil || rep.Scenarios == nil || rep.Groups == nil {
		t.Fatal("nil slices should become empty ones for the page")
	}
}

func TestQAMCPConfigIsValidJSONWithBothServers(t *testing.T) {
	var cfg struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(qaMCPConfig(`/tmp/a "b"`)), &cfg); err != nil {
		t.Fatal(err)
	}
	pw, ok := cfg.MCPServers["playwright"]
	if !ok || !strings.Contains(strings.Join(pw.Args, " "), `/tmp/a "b"`) {
		t.Fatalf("playwright: %+v", pw)
	}
	if _, ok := cfg.MCPServers["laravel-boost"]; !ok {
		t.Fatal("laravel-boost missing")
	}
}

func TestQAImageRejectsUnsafePaths(t *testing.T) {
	s := &server{tasks: &tasks{manager: &TaskManager{}}}
	for _, q := range []string{
		"pr=1&run=../../etc&file=a.png",
		"pr=1&run=0123456789abcdef01234567&file=../a.png",
		"pr=1&run=0123456789abcdef01234567&file=a.txt",
		"pr=0&run=0123456789abcdef01234567&file=a.png",
	} {
		rec := httptest.NewRecorder()
		s.handleQAImage(rec, httptest.NewRequest(http.MethodGet, "/api/qa/image?"+q, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: got %d, want 400", q, rec.Code)
		}
	}
}

// TestQARunDirIsAbsoluteForARelativeDataDir pins the fix for screenshots that
// landed in the PR checkout (Claude's cwd) instead of slash's own data dir.
func TestQARunDirIsAbsoluteForARelativeDataDir(t *testing.T) {
	t.Chdir(t.TempDir())
	dir := qaRunDir("data", 7, "0123456789abcdef01234567")
	if !filepath.IsAbs(dir) {
		t.Fatalf("qaRunDir = %q, want an absolute path", dir)
	}
	if !strings.Contains(qaMCPConfig(dir), dir) {
		t.Errorf("the MCP --output-dir must carry the absolute run dir")
	}
}
