package main

import (
	"reflect"
	"strings"
	"testing"
)

const opsSlug = "plug-and-pay/plug-and-pay-ops"

// twoRepoRegistry configures the primary repo plus plug-and-pay-ops.
func twoRepoRegistry(t *testing.T) {
	t.Helper()
	writeSettings(t, `{"repos":[{"slug":"plug-and-pay/plug-and-pay-ops","key":"ops","baseBranch":"master"}]}`)
}

// Every inbox/search query is scoped to EVERY configured repo — GitHub search
// ORs repeated `repo:` qualifiers — and with one repo it is byte-identical to
// the old hardcoded scope.
func TestRepoSearchScope(t *testing.T) {
	writeSettings(t, "")
	if got, want := repoSearchScope(), "repo:"+repoSlug; got != want {
		t.Fatalf("single-repo scope = %q, want %q", got, want)
	}

	twoRepoRegistry(t)
	got := repoSearchScope()
	if !strings.Contains(got, "repo:"+repoSlug) || !strings.Contains(got, "repo:"+opsSlug) {
		t.Fatalf("two-repo scope = %q, want both repos", got)
	}
}

// statusKey keeps the historical bare-number form for the primary repo — that is
// what makes every existing fixture, stored snapshot and client `?prs=` list
// keep working — and round-trips for a second repo.
func TestStatusKeyRoundTrip(t *testing.T) {
	twoRepoRegistry(t)

	if got := statusKey("", 13000); got != "13000" {
		t.Fatalf("primary statusKey = %q, want the bare number", got)
	}
	if got := statusKey(opsSlug, 12); got != opsSlug+"#12" {
		t.Fatalf("ops statusKey = %q", got)
	}
	for _, in := range []string{"13000", opsSlug + "#12", " " + opsSlug + "#12 "} {
		repo, n := parseStatusKey(in)
		if n == 0 {
			t.Fatalf("parseStatusKey(%q) failed", in)
		}
		if got := statusKey(repo, n); strings.TrimSpace(in) != got {
			t.Fatalf("round trip of %q gave %q", in, got)
		}
	}
	// Junk is dropped, never guessed at.
	if _, n := parseStatusKey("nope"); n != 0 {
		t.Fatalf("garbage key must not parse")
	}
}

// Two repos can each have a PR 12: de-duplication and the hasGraph overlay must
// key on (repo, number), never on the number alone.
func TestDedupeKeepsSameNumberInDifferentRepos(t *testing.T) {
	twoRepoRegistry(t)

	rows := []inboxRow{
		{Number: 12, Title: "primary 12"},
		{Repo: opsSlug, Number: 12, Title: "ops 12"},
		{Repo: opsSlug, Number: 12, Title: "ops 12 again"},
	}
	got := dedupeRowsByNumber(rows)
	if len(got) != 2 {
		t.Fatalf("want 2 rows (one per repo), got %d: %+v", len(got), got)
	}
	if got[0].Title != "primary 12" || got[1].Title != "ops 12" {
		t.Fatalf("wrong rows survived: %+v", got)
	}
}

// The client is told which repos exist so it can tell "a repo I can build a tree
// for" from "a repo only present in a stored snapshot". The primary repo is
// listed in its canonical form: the empty string.
func TestConfiguredRepoList(t *testing.T) {
	twoRepoRegistry(t)

	if got, want := configuredRepoList(), []string{"", opsSlug}; !reflect.DeepEqual(got, want) {
		t.Fatalf("configuredRepoList = %#v, want %#v", got, want)
	}
}

// A `prs=` list may mix both forms, and an unknown repo is never silently turned
// into the primary repo's PR of that number.
func TestParseStatusKeyList(t *testing.T) {
	twoRepoRegistry(t)

	got := parseStatusKeyList("13000, " + opsSlug + "#12,bogus,0")
	want := []prKey{{"", 13000}, {opsSlug, 12}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseStatusKeyList = %#v, want %#v", got, want)
	}
}
