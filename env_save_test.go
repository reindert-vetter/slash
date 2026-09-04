package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// saveEnvValues is the settings page's write path for the Jira credentials, so
// the guarantee that matters most is that it never destroys the rest of a
// hand-maintained .env.
func TestSaveEnvValuesPreservesEverythingElse(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	original := "# slash local config\nSLASH_REPO_DIR=~/dev/plug-and-pay\n\n# Jira feed\n# SLASH_JIRA_EMAIL=you@example.com\nSLASH_GITHUB=off\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SLASH_JIRA_EMAIL", "")
	t.Setenv("SLASH_JIRA_TOKEN", "")

	if err := saveEnvValues(path, map[string]string{
		"SLASH_JIRA_EMAIL": "me@plugandpay.com",
		"SLASH_JIRA_TOKEN": "tok-123",
	}); err != nil {
		t.Fatalf("saveEnvValues: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(raw)
	for _, want := range []string{
		"# slash local config",
		"SLASH_REPO_DIR=~/dev/plug-and-pay",
		"# Jira feed",
		"SLASH_GITHUB=off",
		"SLASH_JIRA_EMAIL=me@plugandpay.com",
		"SLASH_JIRA_TOKEN=tok-123",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	// The commented-out template line is REPLACED, not duplicated below.
	if strings.Contains(got, "# SLASH_JIRA_EMAIL=you@example.com") {
		t.Errorf("commented template line survived:\n%s", got)
	}
	if n := strings.Count(got, "SLASH_JIRA_EMAIL="); n != 1 {
		t.Errorf("SLASH_JIRA_EMAIL written %d times, want 1:\n%s", n, got)
	}
	// The process sees the new value immediately — no restart.
	if os.Getenv("SLASH_JIRA_TOKEN") != "tok-123" {
		t.Errorf("env not applied: %q", os.Getenv("SLASH_JIRA_TOKEN"))
	}
}

// A missing .env is the fresh-checkout case: the file is created rather than
// treated as an error.
func TestSaveEnvValuesCreatesMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	t.Setenv("SLASH_JIRA_SITE", "")
	if err := saveEnvValues(path, map[string]string{"SLASH_JIRA_SITE": "example.atlassian.net"}); err != nil {
		t.Fatalf("saveEnvValues: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) != "SLASH_JIRA_SITE=example.atlassian.net" {
		t.Errorf("unexpected content: %q", string(raw))
	}
}

// envLineKey must see a real assignment and ignore prose, otherwise a comment
// sentence containing "=" would be rewritten as a variable.
func TestEnvLineKey(t *testing.T) {
	cases := map[string]string{
		"SLASH_JIRA_TOKEN=abc":                    "SLASH_JIRA_TOKEN",
		"# SLASH_JIRA_TOKEN=your-token":           "SLASH_JIRA_TOKEN",
		"  SLASH_JIRA_SITE = x ":                  "SLASH_JIRA_SITE",
		"# copy this to .env and adjust = values": "",
		"# a plain comment":                       "",
		"":                                        "",
		"SLASH_REPO_DIR=~/dev/plug-and-pay":       "SLASH_REPO_DIR",
	}
	for line, want := range cases {
		if got := envLineKey(line); got != want {
			t.Errorf("envLineKey(%q) = %q, want %q", line, got, want)
		}
	}
}

// The auth checks turn CLI output into one displayable line, and an expired
// acli session must read as "error" even when the exit code is 0.
func TestAuthOutputHelpers(t *testing.T) {
	if !looksUnauthorized("✗ Error: unauthorized: use 'acli jira auth login' to authenticate") {
		t.Error("expired acli session not recognised")
	}
	if looksUnauthorized("Logged in as reindert@plugandpay.com") {
		t.Error("a healthy session read as unauthorized")
	}
	ghOut := "github.com\n  ✓ Logged in to github.com account reindert-vetter (keyring)\n  - Token: gho_****\n"
	if got := firstMeaningfulLine(ghOut, ""); got != "Logged in to github.com account reindert-vetter (keyring)" {
		t.Errorf("firstMeaningfulLine = %q", got)
	}
	if got := firstMeaningfulLine("\n\n", "fallback"); got != "fallback" {
		t.Errorf("fallback not used: %q", got)
	}
	if got := maskSecret("abcdef123456"); got != "••••3456" {
		t.Errorf("maskSecret = %q", got)
	}
}
