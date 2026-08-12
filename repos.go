package main

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// repos.go is the repo registry: the list of GitHub repositories slash reviews,
// and the per-repo facts every layer needs (local clone dir, base branch, and a
// short key used in run IDs and worktree names).
//
// The app started life single-repo (gh.go's repoSlug/defaultRepoDir) and grew a
// second one. The registry keeps that history harmless through one rule, applied
// everywhere:
//
//	THE PRIMARY REPO IS THE EMPTY STRING.
//
// Internally a PR is identified by (repo, number) where repo is the repo's slug
// — except for the primary repo, which is stored, sent and keyed as "". That is
// what makes the second repo additive instead of a migration:
//
//   - every `repo` DB column defaults to '' and existing rows are already
//     correct (see db.go / the module schemas);
//   - `/pr/<n>` keeps meaning the primary repo, `/pr/<owner-less name>/<n>` is
//     the new form (see api.go);
//   - a deterministic workflow/run ID keeps its exact historical shape for the
//     primary repo, so an Execution started before this existed is still found
//     after a restart; only a non-primary repo adds a `-<key>` segment (see
//     repoRunPrefix).
//
// Configuration lives in <dataDir>/settings.json (see settings.go — gitignored,
// with data/settings.example.json as the committed template):
//
//	"repos": [
//	  {"slug":"plug-and-pay/plug-and-pay","key":"pap","dir":"~/dev/plug-and-pay","baseBranch":"develop","primary":true},
//	  {"slug":"plug-and-pay/plug-and-pay-ops","key":"ops","dir":"~/dev/plug-and-pay-ops","baseBranch":"master"}
//	]
//
// Read once per process (settings.go's cache), so adding a repo takes a restart.
// With no file at all the registry holds exactly one repo — gh.go's built-in
// primary — which is precisely the pre-registry behaviour.

// prKey is the identity of one pull request across repos: a canonical repo
// string (see canonRepo — "" for the primary repo) plus its number. Used
// wherever a bare `int` used to be the key of a map or a lookup, so a PR 12 in
// plug-and-pay-ops can never collide with a PR 12 in plug-and-pay.
type prKey struct {
	Repo string
	PR   int
}

// String is the human/log form: "13000" for the primary repo, "ops#12"
// elsewhere.
func (k prKey) String() string {
	if k.Repo == "" {
		return strconv.Itoa(k.PR)
	}
	return repoKeyOf(k.Repo) + "#" + strconv.Itoa(k.PR)
}

// repoConfig is one reviewed repository.
type repoConfig struct {
	// Slug is "owner/name" as GitHub knows it.
	Slug string `json:"slug"`
	// Key is the short, filesystem- and git-ref-safe identifier used in
	// non-primary run IDs and worktree directory names ("ops"). Derived from
	// the slug's name part when not configured.
	Key string `json:"key"`
	// Dir is the local clone (tilde-expanded on use, see repoDirFor).
	Dir string `json:"dir"`
	// BaseBranch is the branch ensureCommits fetches to make a PR's base SHA
	// resolvable locally. Defaults to "develop" — the historical hardcoded
	// value — so the primary repo behaves exactly as before; plug-and-pay-ops
	// needs "master".
	BaseBranch string `json:"baseBranch"`
	// Primary marks the repo whose PRs keep the bare, un-prefixed identity
	// (empty repo string, `/pr/<n>`, historical run IDs). Exactly one repo is
	// primary; see normalizeRepos.
	Primary bool `json:"primary"`
}

// repoName is the slug's name part — the segment that appears in a URL
// (`/pr/plug-and-pay-ops/12`). Reindert chose the full name over the short key
// there deliberately: a URL is read by humans, a run ID prefix is not.
func (r repoConfig) repoName() string {
	if i := strings.LastIndexByte(r.Slug, '/'); i >= 0 {
		return r.Slug[i+1:]
	}
	return r.Slug
}

var (
	reposMu       sync.RWMutex
	reposList     []repoConfig
	reposInitDone bool
)

// initRepos loads the registry from dataDir's settings.json. Called once at
// startup (main.go) before anything can ask for a repo. Calling it again with a
// different dataDir replaces the registry — which is what a test wants.
func initRepos(dataDir string) {
	list := normalizeRepos(settings(dataDir).Repos)
	reposMu.Lock()
	reposList = list
	reposInitDone = true
	reposMu.Unlock()
}

// builtinRepo is the registry's fallback: gh.go's compiled-in primary repo,
// honouring SLASH_REPO_DIR. Used when settings.json configures no repos at all,
// and prepended when it configures others but omits this one — the ingest,
// comment and chat paths would otherwise lose the repo the app is built around.
func builtinRepo() repoConfig {
	return repoConfig{
		Slug:       repoSlug,
		Key:        defaultRepoKey(repoSlug),
		Dir:        repoDir(),
		BaseBranch: "develop",
		Primary:    true,
	}
}

// normalizeRepos turns the raw settings list into a usable registry: trimmed,
// slug-less entries dropped, duplicate slugs dropped (first wins), defaults
// filled in, the built-in primary guaranteed present, and exactly one entry
// marked Primary (the configured one, else the built-in/first).
func normalizeRepos(raw []repoConfig) []repoConfig {
	var out []repoConfig
	seenSlug := map[string]bool{}
	seenKey := map[string]bool{}
	for _, r := range raw {
		r.Slug = strings.Trim(strings.TrimSpace(r.Slug), "/")
		if r.Slug == "" || seenSlug[strings.ToLower(r.Slug)] {
			continue
		}
		seenSlug[strings.ToLower(r.Slug)] = true
		r.Key = sanitizeRepoKey(strings.TrimSpace(r.Key))
		if r.Key == "" {
			r.Key = defaultRepoKey(r.Slug)
		}
		for seenKey[r.Key] {
			r.Key += "x"
		}
		seenKey[r.Key] = true
		r.Dir = strings.TrimSpace(r.Dir)
		if r.Dir == "" {
			r.Dir = "~/dev/" + r.repoName()
		}
		r.BaseBranch = strings.TrimSpace(r.BaseBranch)
		if r.BaseBranch == "" {
			r.BaseBranch = "develop"
		}
		out = append(out, r)
	}

	if !seenSlug[strings.ToLower(repoSlug)] {
		// The built-in repo is always in the registry, as the first entry, so a
		// settings file listing only a second repo can never orphan it.
		b := builtinRepo()
		if seenKey[b.Key] {
			b.Key += "x"
		}
		out = append([]repoConfig{b}, out...)
	} else if len(out) > 0 {
		// SLASH_REPO_DIR keeps overriding the primary clone even when
		// settings.json names one — it is how the test harness and a
		// throwaway checkout point slash at another copy.
		if env := strings.TrimSpace(repoDirEnv()); env != "" {
			for i := range out {
				if strings.EqualFold(out[i].Slug, repoSlug) {
					out[i].Dir = env
				}
			}
		}
	}
	if len(out) == 0 {
		out = []repoConfig{builtinRepo()}
	}

	primary := -1
	for i := range out {
		if out[i].Primary {
			primary = i
			break
		}
	}
	if primary == -1 {
		// No explicit primary: the built-in repo if present (it is, see above),
		// otherwise the first entry.
		primary = 0
		for i := range out {
			if strings.EqualFold(out[i].Slug, repoSlug) {
				primary = i
				break
			}
		}
	}
	for i := range out {
		out[i].Primary = i == primary
	}
	return out
}

var repoKeyBad = regexp.MustCompile(`[^a-z0-9]+`)

// sanitizeRepoKey reduces a key to lowercase [a-z0-9] with single dashes, so it
// is safe inside a workflow run ID, a git ref path and a directory name.
func sanitizeRepoKey(key string) string {
	return strings.Trim(repoKeyBad.ReplaceAllString(strings.ToLower(key), "-"), "-")
}

// defaultRepoKey derives a key from the slug's name part: the initials of its
// dash-separated words when there are several ("plug-and-pay" → "pap"),
// otherwise the name itself. Keeps a generated key short without needing a
// hand-written one for every repo.
func defaultRepoKey(slug string) string {
	name := slug
	if i := strings.LastIndexByte(slug, '/'); i >= 0 {
		name = slug[i+1:]
	}
	name = sanitizeRepoKey(name)
	parts := strings.Split(name, "-")
	if len(parts) < 2 {
		return name
	}
	var b strings.Builder
	for _, p := range parts {
		if p != "" {
			b.WriteByte(p[0])
		}
	}
	return b.String()
}

// allRepos returns the registry (a copy).
func allRepos() []repoConfig {
	reposMu.RLock()
	if !reposInitDone {
		reposMu.RUnlock()
		return []repoConfig{builtinRepo()}
	}
	out := make([]repoConfig, len(reposList))
	copy(out, reposList)
	reposMu.RUnlock()
	return out
}

// primaryRepo is the repo whose PRs keep the bare identity ("" internally).
func primaryRepo() repoConfig {
	for _, r := range allRepos() {
		if r.Primary {
			return r
		}
	}
	return builtinRepo()
}

// primarySlug is the primary repo's slug — what "" resolves to.
func primarySlug() string { return primaryRepo().Slug }

// canonRepo maps any spelling of a repo onto its CANONICAL INTERNAL form: "" for
// the primary repo, the exact registry slug for any other, and "" for anything
// unknown (a stale link/param can then never address a repo we don't have — it
// simply reads as the primary repo, exactly as it did before this existed).
func canonRepo(repo string) string {
	repo = strings.Trim(strings.TrimSpace(repo), "/")
	if repo == "" {
		return ""
	}
	for _, r := range allRepos() {
		if strings.EqualFold(r.Slug, repo) || strings.EqualFold(r.Key, repo) || strings.EqualFold(r.repoName(), repo) {
			if r.Primary {
				return ""
			}
			return r.Slug
		}
	}
	return ""
}

// knownRepo reports whether repo names a repo in the registry (in any spelling
// canonRepo accepts). Lets a handler tell "not configured" apart from "the
// primary repo", which canonRepo deliberately collapses.
func knownRepo(repo string) bool {
	repo = strings.Trim(strings.TrimSpace(repo), "/")
	if repo == "" {
		return true
	}
	for _, r := range allRepos() {
		if strings.EqualFold(r.Slug, repo) || strings.EqualFold(r.Key, repo) || strings.EqualFold(r.repoName(), repo) {
			return true
		}
	}
	return false
}

// repoFor resolves the full config of a canonical repo string ("" → primary).
func repoFor(repo string) repoConfig {
	if repo == "" {
		return primaryRepo()
	}
	for _, r := range allRepos() {
		if strings.EqualFold(r.Slug, repo) {
			return r
		}
	}
	return primaryRepo()
}

// repoSlugFor is the gh --repo / API value for a canonical repo string.
func repoSlugFor(repo string) string { return repoFor(repo).Slug }

// repoDirFor is the local clone of a canonical repo string, tilde-expanded.
//
// SLASH_REPO_DIR is honoured HERE, per call, for the primary repo — not only at
// init: a test (and the Playwright harness) sets that env var around a temp git
// repo, sometimes after the registry was already built, and a value cached at
// init would silently point at the real ~/dev clone instead.
func repoDirFor(repo string) string {
	if repo == "" {
		if env := strings.TrimSpace(repoDirEnv()); env != "" {
			return expandTilde(env)
		}
	}
	return expandTilde(repoFor(repo).Dir)
}

// baseBranchFor is the branch ensureCommits fetches for this repo's PRs.
func baseBranchFor(repo string) string { return repoFor(repo).BaseBranch }

// repoKeyOf is the short key of a canonical repo string.
func repoKeyOf(repo string) string { return repoFor(repo).Key }

// repoURLName is the segment a review-tree URL uses for this repo:
// "" (nothing — `/pr/<n>`) for the primary repo, the repo's NAME for any other
// (`/pr/plug-and-pay-ops/12`).
func repoURLName(repo string) string {
	if repo == "" {
		return ""
	}
	return repoFor(repo).repoName()
}

// repoRunPrefix is the segment a DETERMINISTIC workflow/run ID inserts for this
// repo: empty for the primary repo — so every historical ID shape
// ("chatmerge-13000", the resolve_call/explain hashes) is byte-identical to what
// a pre-registry build produced and a running Execution survives a restart — and
// "<key>-" for any other repo ("chatmerge-ops-12" via the callers' own layout).
func repoRunPrefix(repo string) string {
	if repo == "" {
		return ""
	}
	return repoKeyOf(repo) + "-"
}

// repoTag is a repo's short human label for a log line or an error message: ""
// for the primary repo (a message about it reads exactly as before), " (ops)"
// otherwise.
func repoTag(repo string) string {
	if repo == "" {
		return ""
	}
	return " (" + repoKeyOf(repo) + ")"
}
