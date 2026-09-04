package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// writeSettings drops a settings.json in a fresh temp dir and points the
// registry at it. Returns the dir so a caller can re-init.
func writeSettings(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if body != "" {
		if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(body), 0o644); err != nil {
			t.Fatalf("write settings: %v", err)
		}
	}
	initRepos(dir)
	t.Cleanup(func() { initRepos(t.TempDir()) })
	return dir
}

// With no settings file at all the registry is exactly the pre-registry world:
// one repo, the built-in primary, "" resolving to it.
func TestRegistryDefaultsToBuiltinPrimary(t *testing.T) {
	writeSettings(t, "")

	all := allRepos()
	if len(all) != 1 {
		t.Fatalf("want 1 repo, got %d: %+v", len(all), all)
	}
	if all[0].Slug != repoSlug || !all[0].Primary {
		t.Fatalf("built-in repo not primary: %+v", all[0])
	}
	if got := canonRepo(""); got != "" {
		t.Fatalf("canonRepo(\"\") = %q, want \"\"", got)
	}
	if got := canonRepo(repoSlug); got != "" {
		t.Fatalf("the primary repo must canonicalize to \"\", got %q", got)
	}
	if got := repoSlugFor(""); got != repoSlug {
		t.Fatalf("repoSlugFor(\"\") = %q", got)
	}
	if got := baseBranchFor(""); got != "develop" {
		t.Fatalf("baseBranchFor(\"\") = %q, want the historical develop", got)
	}
	if got := repoRunPrefix(""); got != "" {
		t.Fatalf("the primary repo must add NO run-ID prefix, got %q", got)
	}
	if got := repoURLName(""); got != "" {
		t.Fatalf("the primary repo must add NO URL segment, got %q", got)
	}
}

// A second repo is addressable by slug, by key and by bare name (the URL form),
// and never collapses onto the primary repo.
func TestRegistrySecondRepo(t *testing.T) {
	writeSettings(t, `{"repos":[
		{"slug":"plug-and-pay/plug-and-pay","key":"pap","dir":"~/dev/plug-and-pay","baseBranch":"develop","primary":true},
		{"slug":"plug-and-pay/plug-and-pay-ops","key":"ops","dir":"~/dev/plug-and-pay-ops","baseBranch":"master"}
	]}`)

	const ops = "plug-and-pay/plug-and-pay-ops"
	for _, spelling := range []string{ops, "ops", "plug-and-pay-ops"} {
		if got := canonRepo(spelling); got != ops {
			t.Fatalf("canonRepo(%q) = %q, want %q", spelling, got, ops)
		}
	}
	if got := baseBranchFor(ops); got != "master" {
		t.Fatalf("baseBranchFor(ops) = %q, want master", got)
	}
	if got := repoKeyOf(ops); got != "ops" {
		t.Fatalf("repoKeyOf(ops) = %q", got)
	}
	if got := repoRunPrefix(ops); got != "ops-" {
		t.Fatalf("repoRunPrefix(ops) = %q, want ops-", got)
	}
	if got := repoURLName(ops); got != "plug-and-pay-ops" {
		t.Fatalf("repoURLName(ops) = %q, want the full name (Reindert's choice)", got)
	}
	if got := repoDirFor(ops); got == repoDirFor("") {
		t.Fatalf("the second repo must have its own clone dir, both are %q", got)
	}
	if !knownRepo("ops") || knownRepo("someone/else") {
		t.Fatalf("knownRepo is wrong: ops=%v else=%v", knownRepo("ops"), knownRepo("someone/else"))
	}
	// An unknown repo reads as the primary repo rather than as a hard error, so
	// a stale link can never address a repo we don't have.
	if got := canonRepo("someone/else"); got != "" {
		t.Fatalf("unknown repo must fall back to the primary, got %q", got)
	}
}

// The built-in primary can never be configured away: a file listing only the
// second repo still keeps plug-and-pay/plug-and-pay as the primary.
func TestRegistryAlwaysKeepsBuiltinRepo(t *testing.T) {
	writeSettings(t, `{"repos":[{"slug":"plug-and-pay/plug-and-pay-ops","key":"ops"}]}`)

	all := allRepos()
	if len(all) != 2 {
		t.Fatalf("want 2 repos (built-in + configured), got %d: %+v", len(all), all)
	}
	if primarySlug() != repoSlug {
		t.Fatalf("primary = %q, want the built-in %q", primarySlug(), repoSlug)
	}
	if canonRepo("plug-and-pay/plug-and-pay-ops") == "" {
		t.Fatalf("the configured second repo went missing")
	}
}

// Defaults are derived, so a minimal entry is usable: key from the name's
// initials, dir under ~/dev, baseBranch develop.
func TestRegistryDerivesDefaults(t *testing.T) {
	writeSettings(t, `{"repos":[{"slug":"plug-and-pay/some-other-repo"}]}`)

	r := repoFor(canonRepo("some-other-repo"))
	if r.Key != "sor" {
		t.Fatalf("derived key = %q, want sor", r.Key)
	}
	if r.Dir != "~/dev/some-other-repo" {
		t.Fatalf("derived dir = %q", r.Dir)
	}
	if r.BaseBranch != "develop" {
		t.Fatalf("derived baseBranch = %q", r.BaseBranch)
	}
	if r.Primary {
		t.Fatalf("a non-built-in repo must not become primary by default")
	}
}

// Garbage in the file can never break the app: a slug-less entry is dropped, a
// duplicate slug is dropped, and an unsafe key is sanitized (it ends up in run
// IDs, git refs and directory names).
func TestRegistryNormalizesJunk(t *testing.T) {
	writeSettings(t, `{"repos":[
		{"slug":"  "},
		{"slug":"plug-and-pay/plug-and-pay-ops","key":"Ops/Team ..","baseBranch":" master "},
		{"slug":"plug-and-pay/plug-and-pay-ops","key":"dupe"}
	]}`)

	all := allRepos()
	if len(all) != 2 {
		t.Fatalf("want built-in + one ops entry, got %d: %+v", len(all), all)
	}
	ops := repoFor(canonRepo("plug-and-pay/plug-and-pay-ops"))
	if ops.Key != "ops-team" {
		t.Fatalf("key not sanitized: %q", ops.Key)
	}
	if ops.BaseBranch != "master" {
		t.Fatalf("baseBranch not trimmed: %q", ops.BaseBranch)
	}
}

// Unparsable JSON is not an error either — it degrades to the single built-in
// repo, exactly like loadSettingsFile does for the `me` half.
func TestRegistrySurvivesBadJSON(t *testing.T) {
	writeSettings(t, `{ this is not json`)

	if len(allRepos()) != 1 || primarySlug() != repoSlug {
		t.Fatalf("bad JSON must degrade to the built-in repo, got %+v", allRepos())
	}
}

// A repo configured as primary in settings.json, even when it isn't the
// built-in plug-and-pay, must actually become primary. Before the fix the
// built-in repo was prepended with Primary forced true, so the "first
// Primary wins" scan below always found it first — this repo's own
// "primary":true never got a chance.
func TestRegistryConfiguredRepoCanBePrimary(t *testing.T) {
	writeSettings(t, `{"repos":[{"slug":"plug-and-pay/plug-and-pay-ops","key":"ops","primary":true}]}`)

	if primarySlug() != "plug-and-pay/plug-and-pay-ops" {
		t.Fatalf("primary = %q, want the configured ops repo", primarySlug())
	}
	if canonRepo(repoSlug) == "" {
		t.Fatalf("the built-in repo must still be in the registry, just not primary")
	}
}

// An explicit "dir" in settings.json for the primary repo must win over
// SLASH_REPO_DIR — that env var is also how ensureEnvSetup persists the
// primary repo's dir on first run (see env.go), so it is normally set on
// every later run too; without this fix an explicit settings.json change
// could never take effect.
func TestRegistryConfiguredPrimaryDirWinsOverEnv(t *testing.T) {
	t.Setenv("SLASH_REPO_DIR", "/tmp/env-primary-dir")
	writeSettings(t, fmt.Sprintf(`{"repos":[{"slug":%q,"dir":"/tmp/configured-primary-dir","primary":true}]}`, repoSlug))

	if got := repoDirFor(""); got != "/tmp/configured-primary-dir" {
		t.Fatalf("repoDirFor(\"\") = %q, want the configured dir", got)
	}
}

// Without an explicit dir configured, SLASH_REPO_DIR keeps working as the
// override — the test harness relies on exactly this (see chat_merge_test.go
// etc, which set it AFTER the registry may already have been built).
func TestRegistryUnconfiguredPrimaryDirStillHonoursEnv(t *testing.T) {
	writeSettings(t, "")
	t.Setenv("SLASH_REPO_DIR", "/tmp/env-primary-dir")

	if got := repoDirFor(""); got != "/tmp/env-primary-dir" {
		t.Fatalf("repoDirFor(\"\") = %q, want the env override", got)
	}
}
