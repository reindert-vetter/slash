package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// usernames.go resolves a GitHub login to a human name + avatar, so the UI can
// show "Dennis" instead of "dennissloove" (the PR-inbox author column, the
// reviewer tooltips, and — later — the comment authors in the review tree).
//
// Two sources, in this precedence:
//
//  1. <dataDir>/names.json — a hand-maintained {"login": "Full Name"} map. It
//     wins, because a GitHub profile name is freely editable, frequently empty,
//     and sometimes just the username again; the local map is the one place a
//     team can correct that without touching code.
//  2. The GitHub profile `name` (batched `user(login:)` lookup).
//
// Neither yielding anything leaves the name EMPTY, and the frontend then falls
// back to the bare login (deliberately unmodified — no forced capitalisation,
// see displayNameOf in src/avatar.mjs). Cutting the full name down to a first
// name also happens in the frontend, so a future caller can show the full name
// without a backend change.
//
// WRITE BOUNDARY: this is a pure read plus a process-lifetime, in-memory cache —
// nothing durable is written, so it is allowed outside a workflow. Same
// operational carve-out as TaskManager.CurrentUser (/api/me) and the avatar
// image cache; see .claude/rules/workflows-write-boundary.md. The cache is
// deliberately package-level rather than a TaskManager field, mirroring
// ingest_progress.go's in-memory map.

// displayUser is one resolved identity as the frontend consumes it. Name is the
// FULL name (or "" when unknown).
type displayUser struct {
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl"`
}

// nameLookupCap bounds one /api/names request, so a hostile/broken caller can
// never turn a single request into an unbounded GraphQL query.
const nameLookupCap = 100

var (
	userNameMu sync.Mutex
	// userNameCache holds every login we already looked up. A login that
	// resolved to nothing is cached too (negative caching, an entry with an
	// empty Name/AvatarURL) so a bot/deleted account is never re-queried in a
	// polling loop.
	userNameCache = map[string]displayUser{}
)

// skipNameLookup reports logins we must never send to GitHub: the empty string,
// the "reviewer" sentinel the UI stores as the author of its own comments (not
// a GitHub account at all), and a bot login — `user(login:)` only resolves
// Users, so a "[bot]" suffix is a guaranteed miss.
func skipNameLookup(login string) bool {
	return login == "" || login == "reviewer" || strings.Contains(login, "[bot]")
}

// namesFileOverride reads <dataDir>/names.json once per data dir (so editing it
// takes a restart — it's a rarely-changing team list). A missing file is the
// normal case and yields an empty map; so does an unparsable one (the lookup
// then simply falls through to the GitHub profile name, rather than failing a
// request over a hand-edited file). Cached per dataDir rather than once per
// process so a test can point at its own temp dir.
func namesFileOverride(dataDir string) map[string]string {
	namesMu.Lock()
	defer namesMu.Unlock()
	if m, ok := namesByDir[dataDir]; ok {
		return m
	}
	m, _ := loadNamesFile(filepath.Join(dataDir, "names.json"))
	namesByDir[dataDir] = m
	return m
}

var (
	namesMu    sync.Mutex
	namesByDir = map[string]map[string]string{}
)

// loadNamesFile parses a {"login": "Full Name"} map. Split out from the cached
// wrapper so it is directly testable.
func loadNamesFile(path string) (map[string]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}, err
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		return map[string]string{}, err

	}
	if m == nil {
		m = map[string]string{}
	}
	return m, nil
}

// resolveDisplayName applies the precedence: the local names.json override
// first, then the GitHub profile name, then "" (the frontend falls back to the
// login itself). Pure — the whole precedence rule in one testable place.
func resolveDisplayName(login, ghName string, override map[string]string) string {
	if n := strings.TrimSpace(override[login]); n != "" {
		return n
	}
	return strings.TrimSpace(ghName)
}

// collabMu/collabLoaded guard ensureCollaboratorsLoaded's once-per-process
// warm-up (see below).
var (
	collabMu     sync.Mutex
	collabLoaded bool
)

// ensureCollaboratorsLoaded fetches the repo's collaborators and warms
// userNameCache with every one of their display names, once per process
// lifetime (same restart-to-refresh trade-off as namesFileOverride). Without
// this, matchingLogins could only find a colleague whose name had already
// surfaced somewhere else in this run (e.g. as a PR author already shown on
// the dashboard); with it, any collaborator's name is searchable right away.
// A failed fetch is not sticky: the next search call retries.
func ensureCollaboratorsLoaded(ctx context.Context, tm *TaskManager) {
	if tm == nil || tm.gh == nil {
		return
	}
	collabMu.Lock()
	defer collabMu.Unlock()
	if collabLoaded {
		return
	}
	// Detached from the triggering request for the same reason as DisplayNames
	// above: this warm-up runs once per process and its result is shared, so a
	// reviewer typing on in the search box must not be able to cancel it.
	ctx = context.WithoutCancel(ctx)
	collabs, err := tm.gh.ListCollaborators(ctx)
	if err != nil {
		return
	}
	logins := make([]string, 0, len(collabs))
	for _, c := range collabs {
		logins = append(logins, c.Login)
	}
	tm.DisplayNames(ctx, logins) // batches one GitHub call, warms userNameCache
	collabLoaded = true
}

// matchingLogins returns every known login whose login or resolved display
// name contains query (case-insensitive): the local names.json override plus
// whatever DisplayNames/ensureCollaboratorsLoaded has cached in userNameCache.
// Used by /api/prs/search so a reviewer can also search by AUTHOR NAME, which
// GitHub's own free-text PR search does not match against. Capped so a broad
// query never fans out into an unbounded number of extra author: searches.
const matchingLoginsCap = 5

func matchingLogins(dataDir, query string) []string {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(login string) bool {
		if login == "" || seen[login] {
			return len(out) >= matchingLoginsCap
		}
		seen[login] = true
		out = append(out, login)
		return len(out) >= matchingLoginsCap
	}
	for login, name := range namesFileOverride(dataDir) {
		if strings.Contains(strings.ToLower(login), q) || strings.Contains(strings.ToLower(name), q) {
			if add(login) {
				return out
			}
		}
	}
	userNameMu.Lock()
	defer userNameMu.Unlock()
	for login, u := range userNameCache {
		if strings.Contains(strings.ToLower(login), q) || strings.Contains(strings.ToLower(u.Name), q) {
			if add(login) {
				return out
			}
		}
	}
	return out
}

// DisplayNames resolves logins to their name + avatar, batching every
// not-yet-cached login into ONE GitHub call and caching the outcome (including
// misses) for the process lifetime. A failed lookup is not an error for the
// caller: the logins involved simply resolve to an empty name, which the
// frontend renders as the bare login.
func (m *TaskManager) DisplayNames(ctx context.Context, logins []string) map[string]displayUser {
	override := namesFileOverride(m.dataDir)

	// Collect what still needs a lookup, deduped and skip-listed.
	want := make([]string, 0, len(logins))
	missing := []string{}
	seen := map[string]bool{}
	userNameMu.Lock()
	for _, login := range logins {
		if skipNameLookup(login) || seen[login] {
			continue
		}
		seen[login] = true
		want = append(want, login)
		if _, cached := userNameCache[login]; !cached {
			missing = append(missing, login)
		}
	}
	userNameMu.Unlock()

	if len(missing) > 0 && m.gh != nil {
		// Deliberately NOT the caller's own ctx: the outcome is cached for the
		// whole process and shared by every later request, so it must not
		// depend on the one request that happened to trigger it. A reviewer
		// refreshing the inbox (or typing on in the search box) makes the
		// browser drop that connection, which cancelled r.Context() and killed
		// the `gh` subprocess mid-lookup. UsersByLogin derives its own bounded
		// cliTimeout from this ctx, so it still cannot hang forever. Same
		// reasoning as handleAuthStatus (auth_status.go).
		found, err := m.gh.UsersByLogin(context.WithoutCancel(ctx), missing)
		if err != nil {
			m.logf("names: lookup of %d login(s) failed: %v", len(missing), err)
		} else {
			// Only a lookup that actually SUCCEEDED may write the cache — a
			// miss inside a successful batch is a genuine "no such user" and is
			// cached as an empty entry (negative caching), but a FAILED call
			// says nothing about these logins. Caching it anyway turned one
			// cancelled/killed `gh` call into permanently name- and
			// avatar-less rows for every login in that batch, for the rest of
			// the process lifetime; leaving them uncached simply retries on the
			// next request.
			userNameMu.Lock()
			for _, login := range missing {
				u := found[login] // zero value for a login that didn't resolve
				userNameCache[login] = displayUser{Name: u.Name, AvatarURL: u.AvatarURL}
			}
			userNameMu.Unlock()
		}
	}

	out := make(map[string]displayUser, len(want))
	userNameMu.Lock()
	defer userNameMu.Unlock()
	for _, login := range want {
		cached := userNameCache[login]
		// The override wins over whatever GitHub reported, and also applies to
		// a login whose lookup found nothing (or never ran, offline).
		out[login] = displayUser{
			Name:      resolveDisplayName(login, cached.Name, override),
			AvatarURL: cached.AvatarURL,
		}
	}
	return out
}
