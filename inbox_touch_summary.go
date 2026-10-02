package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// touchSummary is the deterministic "what changed" summary of a PR's
// migration and API files (see classifyTouched), shown in place of the full
// row in the overview's "Migrations & API changes" section. It is structured
// rather than prose so the frontend can phrase it in the interface language
// (renderTouchSummary in src/overview.mjs). Derived purely from the diff — no
// Claude call — and cached per head SHA (touchSummaryCache).
type touchSummary struct {
	DB  []touchItem `json:"db,omitempty"`
	API []touchItem `json:"api,omitempty"`
}

// touchItem is one table/route file/class the PR changes.
//
// DB kinds: "create" (new table), "alter" (Add/Del/Chg columns), "drop"
// (table dropped), "rename" (Name is "old → new"), "migration" (a migration
// with no recognisable Schema:: call — usually a data migration; Name is the
// file name without its date prefix).
//
// API kinds: "routes" (Name is the routes file; Add/Del are "GET /path"
// entries), "resource"/"request"/"controller" (Name is the class; Add/Del are
// array keys that appeared/disappeared, New marks an added file).
type touchItem struct {
	Kind string   `json:"kind"`
	Name string   `json:"name"`
	New  bool     `json:"new,omitempty"`
	Add  []string `json:"add,omitempty"`
	Del  []string `json:"del,omitempty"`
	Chg  []string `json:"chg,omitempty"`
}

// touchedFile is one changed file as the REST files endpoint returns it.
type touchedFile struct {
	Path   string
	Status string // added | modified | removed | renamed
	Patch  string // unified diff hunk text; empty for a huge/binary file
}

// touchListCap caps every Add/Del/Chg list (and the routes list) so one wide
// PR cannot blow a row up; the frontend clamps to two lines anyway.
const touchListCap = 8

var (
	reTouchSchema  = regexp.MustCompile(`Schema::(?:connection\([^)]*\)->)?(create|table|drop|dropIfExists|rename)\(\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?`)
	reTableColumn  = regexp.MustCompile(`\$table->(\w+)\(\s*(\[[^\]]*\]|['"][^'"]+['"])`)
	reRenameColumn = regexp.MustCompile(`\$table->renameColumn\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]`)
	reQuoted       = regexp.MustCompile(`['"]([^'"]+)['"]`)
	reDownFunc     = regexp.MustCompile(`function\s+down\s*\(`)
	reArrayKey     = regexp.MustCompile(`^\s*['"]([A-Za-z0-9_.*-]+)['"]\s*=>`)
	reRoute        = regexp.MustCompile(`(?:Route::|->)(get|post|put|patch|delete|options|any|apiResource|resource)\(\s*['"]([^'"]*)['"]`)
	reMigrationPfx = regexp.MustCompile(`^\d{4}_\d{2}_\d{2}_\d{6}_`)
)

// nonColumnMethods are $table-> calls whose first quoted argument is not a
// column being added (indexes, keys) — skipped in an "alter" item.
var nonColumnMethods = map[string]bool{
	"foreign": true, "unique": true, "index": true, "primary": true,
	"spatialIndex": true, "fullText": true, "dropForeign": true,
	"dropIndex": true, "dropUnique": true, "dropPrimary": true,
	"dropFullText": true, "dropSpatialIndex": true, "renameIndex": true,
	"dropConstrainedForeignId": true, "dropForeignIdFor": true,
}

// summarizeTouched builds the summary from the PR's changed migration/API
// files. Order follows the input (statusesFor's path order), so it is stable.
func summarizeTouched(files []touchedFile) *touchSummary {
	sum := &touchSummary{}
	for _, f := range files {
		mig, api := classifyTouched([]string{f.Path})
		if len(mig) > 0 {
			sum.DB = append(sum.DB, summarizeMigration(f)...)
		}
		if len(api) > 0 {
			if it, ok := summarizeAPIFile(f); ok {
				sum.API = append(sum.API, it)
			}
		}
	}
	if len(sum.DB) == 0 && len(sum.API) == 0 {
		return nil
	}
	return sum
}

// addedLines returns the patch's "+" lines (without the marker), stopping at
// a migration's down() so its reverse operations never read as changes.
func addedLines(patch string, stopAtDown bool) []string {
	var out []string
	for _, l := range strings.Split(patch, "\n") {
		if strings.HasPrefix(l, "+++") || !strings.HasPrefix(l, "+") {
			if stopAtDown && reDownFunc.MatchString(l) {
				break
			}
			continue
		}
		body := l[1:]
		if stopAtDown && reDownFunc.MatchString(body) {
			break
		}
		out = append(out, body)
	}
	return out
}

func summarizeMigration(f touchedFile) []touchItem {
	var items []touchItem
	var cur *touchItem
	for _, l := range addedLines(f.Patch, true) {
		if m := reTouchSchema.FindStringSubmatch(l); m != nil {
			switch m[1] {
			case "create":
				items = append(items, touchItem{Kind: "create", Name: m[2]})
			case "table":
				items = append(items, touchItem{Kind: "alter", Name: m[2]})
			case "drop", "dropIfExists":
				items = append(items, touchItem{Kind: "drop", Name: m[2]})
			case "rename":
				items = append(items, touchItem{Kind: "rename", Name: m[2] + " → " + m[3]})
			}
			cur = &items[len(items)-1]
			continue
		}
		if cur == nil || cur.Kind != "alter" {
			continue
		}
		if m := reRenameColumn.FindStringSubmatch(l); m != nil {
			cur.Chg = appendCapped(cur.Chg, m[1]+" → "+m[2])
			continue
		}
		for _, m := range reTableColumn.FindAllStringSubmatch(l, -1) {
			method := m[1]
			names := quotedIn(m[2])
			switch {
			case nonColumnMethods[method] || len(names) == 0:
			case method == "dropColumn" || method == "dropColumns":
				cur.Del = appendCapped(cur.Del, names...)
			case strings.Contains(l, "->change()"):
				cur.Chg = appendCapped(cur.Chg, names[0])
			default:
				cur.Add = appendCapped(cur.Add, names[0])
			}
		}
	}
	if len(items) == 0 {
		name := strings.TrimSuffix(path.Base(f.Path), ".php")
		items = append(items, touchItem{Kind: "migration", Name: reMigrationPfx.ReplaceAllString(name, ""), New: f.Status == "added"})
	}
	return items
}

func summarizeAPIFile(f touchedFile) (touchItem, bool) {
	segs := strings.Split(strings.ToLower(f.Path), "/")
	name := strings.TrimSuffix(path.Base(f.Path), ".php")
	it := touchItem{Name: name, New: f.Status == "added"}
	kind := ""
	for i, d := range segs[:len(segs)-1] {
		switch d {
		case "routes":
			kind = "routes"
		case "controllers", "requests", "resources":
			if i > 0 && segs[i-1] == "http" && kind != "routes" {
				kind = strings.TrimSuffix(d, "s")
			}
		}
	}
	if kind == "" {
		return it, false
	}
	it.Kind = kind
	if f.Status == "removed" {
		return it, true
	}
	plus, minus := diffSides(f.Patch)
	if kind == "routes" {
		it.Add = routesIn(plus, minus)
		it.Del = routesIn(minus, plus)
		return it, true
	}
	if kind == "controller" {
		return it, true
	}
	it.Add = keysIn(plus, minus)
	if !it.New {
		it.Del = keysIn(minus, plus)
	}
	return it, true
}

// diffSides splits a patch into its "+" and "-" line bodies.
func diffSides(patch string) (plus, minus []string) {
	for _, l := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(l, "+++"), strings.HasPrefix(l, "---"):
		case strings.HasPrefix(l, "+"):
			plus = append(plus, l[1:])
		case strings.HasPrefix(l, "-"):
			minus = append(minus, l[1:])
		}
	}
	return plus, minus
}

// keysIn returns the array keys ('key' =>) on `lines` that do not also occur
// on `other` — a key on both sides is a realigned/edited line, not a field
// that appeared or disappeared.
func keysIn(lines, other []string) []string {
	return uniqueNotIn(extract(lines, reArrayKey, nil), extract(other, reArrayKey, nil))
}

// routesIn returns the route definitions on `lines` not also on `other`.
func routesIn(lines, other []string) []string {
	return uniqueNotIn(extract(lines, reRoute, routeLabel), extract(other, reRoute, routeLabel))
}

func routeLabel(m []string) string {
	verb := strings.ToUpper(m[1])
	if m[1] == "apiResource" || m[1] == "resource" {
		verb = "RESOURCE"
	}
	return verb + " " + m[2]
}

func extract(lines []string, re *regexp.Regexp, label func([]string) string) []string {
	var out []string
	for _, l := range lines {
		for _, m := range re.FindAllStringSubmatch(l, -1) {
			if label != nil {
				out = append(out, label(m))
			} else {
				out = append(out, m[1])
			}
		}
	}
	return out
}

func uniqueNotIn(vals, other []string) []string {
	skip := map[string]bool{}
	for _, o := range other {
		skip[o] = true
	}
	var out []string
	for _, v := range vals {
		if skip[v] {
			continue
		}
		skip[v] = true
		out = appendCapped(out, v)
	}
	return out
}

func quotedIn(s string) []string {
	var out []string
	for _, m := range reQuoted.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

func appendCapped(list []string, vals ...string) []string {
	for _, v := range vals {
		if len(list) >= touchListCap {
			return list
		}
		list = append(list, v)
	}
	return list
}

// touchSummaryCache memoises a summary per repo#number@headSHA: the patches
// only change with a new head commit, so the per-PR REST call happens once per
// push, not on every inbox refresh. Purely a cache of a GitHub read (like
// ghLoginCache) — losing it on a restart only costs a refetch.
var touchSummaryCache = struct {
	sync.Mutex
	m map[string]*touchSummary
}{m: map[string]*touchSummary{}}

// addTouchSummaries fills TouchSummary for every "Migrations & API changes"
// row. Runs inside the pr_inbox tracker's refreshInbox Activity (via
// buildInboxSnapshot), so the network reads are an Activity side effect and
// the result lands in the stored snapshot. A failed fetch leaves that row
// without a summary (the frontend then falls back to the file names) and is
// not cached, so the next refresh retries.
func addTouchSummaries(ctx context.Context, sections []inboxSection, statuses map[string]prStatus) {
	type job struct {
		key, repo string
		number    int
	}
	var jobs []job
	for _, s := range sections {
		if s.Title != touchedSectionTitle {
			continue
		}
		for _, r := range s.PRs {
			jobs = append(jobs, job{rowKey(r), r.Repo, r.Number})
		}
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, j := range jobs {
		st, ok := statuses[j.key]
		if !ok {
			continue
		}
		cacheKey := ""
		if st.headSHA != "" {
			cacheKey = j.key + "@" + st.headSHA
			touchSummaryCache.Lock()
			cached, hit := touchSummaryCache.m[cacheKey]
			touchSummaryCache.Unlock()
			if hit {
				st.TouchSummary = cached
				statuses[j.key] = st
				continue
			}
		}
		wanted := map[string]bool{}
		for _, p := range append(append([]string{}, st.MigrationFiles...), st.APIFiles...) {
			wanted[p] = true
		}
		wg.Add(1)
		go func(j job, wanted map[string]bool, cacheKey string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			files, err := fetchTouchedFiles(ctx, j.repo, j.number, wanted)
			if err != nil {
				return
			}
			sum := summarizeTouched(files)
			if cacheKey != "" {
				touchSummaryCache.Lock()
				touchSummaryCache.m[cacheKey] = sum
				touchSummaryCache.Unlock()
			}
			mu.Lock()
			st := statuses[j.key]
			st.TouchSummary = sum
			statuses[j.key] = st
			mu.Unlock()
		}(j, wanted, cacheKey)
	}
	wg.Wait()
}

// fetchTouchedFiles reads a PR's changed files WITH their patches through the
// paginated REST endpoint and keeps only the `wanted` paths, in path order.
func fetchTouchedFiles(ctx context.Context, repo string, number int, wanted map[string]bool) ([]touchedFile, error) {
	cmd := exec.CommandContext(ctx, "gh", "api", "--paginate", "--slurp",
		fmt.Sprintf("repos/%s/pulls/%d/files?per_page=%d", repoSlugFor(repo), number, ghFilesPageSize))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh api pulls/%d/files: %w: %s", number, err, strings.TrimSpace(stderr.String()))
	}
	return parseTouchedFiles(out, wanted)
}

// parseTouchedFiles decodes `gh api --paginate --slurp` output (an array of
// page arrays) into the wanted files, sorted by path. Split out for tests.
func parseTouchedFiles(out []byte, wanted map[string]bool) ([]touchedFile, error) {
	var pages [][]struct {
		Filename string `json:"filename"`
		Status   string `json:"status"`
		Patch    string `json:"patch"`
	}
	if err := json.Unmarshal(out, &pages); err != nil {
		return nil, fmt.Errorf("parse pulls files: %w", err)
	}
	var files []touchedFile
	for _, page := range pages {
		for _, f := range page {
			if wanted[f.Filename] {
				files = append(files, touchedFile{Path: f.Filename, Status: f.Status, Patch: f.Patch})
			}
		}
	}
	sort.Slice(files, func(i, k int) bool { return files[i].Path < files[k].Path })
	return files, nil
}
