package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// settings.go serves the local, per-reviewer settings file. Today it answers
// exactly one question — "which @mentions in a comment body are about ME?" —
// so a mention of the local reviewer can be highlighted in the comment body and
// promoted to the "Mentioned" section at the top of the block index
// (src/mentions.mjs, src/BlockList.mjs).
//
// One source, exactly the names.json/praise-words.json pattern (see
// usernames.go / praisewords.go):
//
//	<dataDir>/settings.json — {"me": {"login": "…", "aliases": ["…"]}}.
//	Missing or unparsable → empty settings, never an error: a hand-edited local
//	file must not be able to break the review flow.
//
// Deliberately NOT shipped in the repo and listed in .gitignore (unlike
// data/names.json, which is a team-wide list): this names ONE person, and every
// user of slash is a different one. data/settings.example.json is the committed
// template.
//
// PRECEDENCE against GET /api/me: settings.json WINS. /api/me
// (TaskManager.CurrentUser → `gh api user`) already knows the authenticated
// login, and that stays the fallback — so mention detection works with no file
// at all, matching `@<your-login>`. The file exists for the two things /api/me
// cannot give: overriding that login, and adding the SHORTER forms people
// actually type (`@reindert` for the login `reindert-vetter`). Those aliases are
// deliberately explicit rather than derived from the login (a "first segment
// before the dash" heuristic would turn the login `dev-tools` into a `@dev`
// match).
//
// Deliberately a THIRD file next to names.json and praise-words.json instead of
// swallowing them: names.json is a team-wide list that IS committed, and
// praise-words.json is pre-existing with its own endpoint/tests — merging them
// would be a migration with no functional gain. New PER-USER settings belong
// here.
//
// WRITE BOUNDARY: a pure read plus a process-lifetime, in-memory cache —
// nothing durable is written, so it is allowed outside a workflow. Same
// operational carve-out as /api/me, /api/names and /api/praisewords; see
// .claude/rules/workflows-write-boundary.md.

// meSettings is the "who am I" half of the settings file. Login overrides the
// login /api/me reports; Aliases are extra @mention spellings that also mean me.
type meSettings struct {
	Login   string   `json:"login"`
	Aliases []string `json:"aliases"`
}

// appSettings is the whole file. Two fields today, room for more later — which
// is the point of a general settings.json over a mentions-only file.
type appSettings struct {
	Me meSettings `json:"me"`
	// Repos is the reviewed-repository registry (see repos.go): which repos
	// slash lists PRs from, where their local clone lives, and which branch a
	// PR's base is fetched from. Empty/absent → exactly one repo, gh.go's
	// built-in primary, i.e. the pre-registry behaviour.
	Repos []repoConfig `json:"repos"`
}

// settings returns the effective settings for one data dir, reading
// <dataDir>/settings.json once (so editing it takes a restart, like names.json).
// Cached per dataDir rather than once per process so a test can point at its own
// temp dir.
func settings(dataDir string) appSettings {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	if s, ok := settingsByDir[dataDir]; ok {
		return s
	}
	s := loadSettingsFile(filepath.Join(dataDir, "settings.json"))
	settingsByDir[dataDir] = s
	return s
}

var (
	settingsMu    sync.Mutex
	settingsByDir = map[string]appSettings{}
)

// loadSettingsFile parses the settings file and normalizes it: login/aliases
// trimmed, empties dropped, aliases deduped (case-insensitively, since mention
// matching is case-insensitive anyway). Anything that goes wrong — no file, bad
// JSON — yields empty settings, so the caller never has to handle an error and
// the frontend simply falls back to /api/me. Split out from the cached wrapper
// so it is directly testable.
func loadSettingsFile(path string) appSettings {
	var s appSettings
	raw, err := os.ReadFile(path)
	if err != nil {
		return appSettings{Me: meSettings{Aliases: []string{}}, Repos: []repoConfig{}}
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return appSettings{Me: meSettings{Aliases: []string{}}, Repos: []repoConfig{}}
	}
	s.Me.Login = strings.TrimSpace(s.Me.Login)
	out := []string{}
	seen := map[string]bool{}
	for _, a := range s.Me.Aliases {
		a = strings.TrimSpace(a)
		key := strings.ToLower(a)
		if a == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, a)
	}
	s.Me.Aliases = out
	if s.Repos == nil {
		s.Repos = []repoConfig{}
	}
	// The repo list is normalized by normalizeRepos (repos.go), not here: it
	// needs defaults that only the registry knows (the built-in primary, the
	// derived key/dir/baseBranch), and it must happen once at init rather than
	// on every settings() read.
	return s
}

// handleSettings serves GET /api/settings →
// {"ok":true,"me":{"login":"…","aliases":[…]}}. Read-only, always 200 (see
// loadSettingsFile: there is no failure mode a caller could act on), same
// contract as handleMe/handleNames/handlePraiseWords.
func (s *server) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg := settings(s.dataDir)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"me": map[string]any{"login": cfg.Me.Login, "aliases": cfg.Me.Aliases},
	})
}
