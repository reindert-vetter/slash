// plan_current_code.go — GET /api/plan/current, the read-only "what does this
// file look like RIGHT NOW" behind the plan page's block columns.
//
// Reviewer request (task 26 of todo/plan-page-workflow.md): show the CURRENT
// code next to the code a plan block proposes, in the review tree's own
// side-by-side block shape, and read that current code from **the reviewer's
// own werkmap, if there is one**.
//
// Read-only, so it needs no workflow (.claude/rules/workflows-write-boundary.md):
// it opens one file for reading inside a checkout the reviewer already has, and
// writes nothing anywhere — not the plan document, not the checkout store, not
// the workflow history. The werkmap it reads from is exactly the one
// plan_execute.go would implement the plan in:
//
//  1. the werkmap this plan is already sticky to (`plan_checkout`, written by
//     the plan_execute Activity — read here, never written), else
//  2. the first clean candidate of the review tree's own selection ladder
//     (`listCheckoutCandidates`, the same one chat_checkout.go/
//     resolvePlanWorkDir use), so a plan that was never executed yet still
//     shows real code.
//
// The resolved directory is remembered in memory per plan key for
// planCurrentDirTTL — the same operational-cache carve-out the heartbeat map
// and the Jira comment cache have: it is not the source of truth about
// anything (the ladder is, and it is re-run once the entry expires), and it is
// gone after a restart. Without it every block card of every column would pay
// for a handful of `git` calls.
//
// See .claude/docs/plan-page.md.
package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	// planCurrentMaxBytes bounds what one response carries: a plan block is a
	// sketch of a function, and the page renders the file next to it — a
	// multi-megabyte generated file has no business travelling to the browser.
	planCurrentMaxBytes = 256 * 1024
	// planCurrentDirTTL is how long the resolved werkmap is reused before the
	// ladder is asked again (a checkout the reviewer moves/deletes must not
	// stay cached forever).
	planCurrentDirTTL = 5 * time.Minute
	// planCurrentTimeout bounds the git reads of the ladder.
	planCurrentTimeout = 20 * time.Second
)

// planCurrentFilePattern is the allow-list for the requested path. A plan block
// titles itself with a repo-relative path ("app/Foo.php"), and this value is
// joined onto a real directory, so it is validated rather than trusted:
// segments of word characters/dot/dash only, never absolute, never a "..".
var planCurrentFilePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$`)

type planCurrentDirEntry struct {
	dir string
	at  time.Time
}

var (
	planCurrentDirMu    sync.Mutex
	planCurrentDirCache = map[string]planCurrentDirEntry{}
)

// handlePlanCurrentCode serves GET /api/plan/current?key=KEY&file=path.
//
// `found:false` is an ordinary, ok answer — it is what the page renders as the
// word "nieuw bestand" (a block proposing a file that does not exist yet), and
// it is also the answer when there is no werkmap at all. An error status is
// reserved for a malformed request.
func (s *server) handlePlanCurrentCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("key")))
	if !planKeyPattern.MatchString(key) {
		http.Error(w, "invalid issue key", http.StatusBadRequest)
		return
	}
	file := strings.TrimSpace(r.URL.Query().Get("file"))
	if file == "" || !planCurrentFilePattern.MatchString(file) || strings.Contains(file, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), planCurrentTimeout)
	defer cancel()
	dir := planCurrentWorkDir(ctx, s.dataDir, key)
	if dir == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "found": false, "file": file})
		return
	}
	code, truncated, ok := readPlanCurrentFile(dir, file)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "found": ok, "file": file, "dir": dir,
		"code": code, "truncated": truncated,
	})
}

// readPlanCurrentFile reads one repo-relative file out of dir, bounded. The
// join is re-checked against dir afterwards, so even a path the pattern let
// through can never escape the checkout.
func readPlanCurrentFile(dir, file string) (code string, truncated bool, ok bool) {
	full := filepath.Join(dir, filepath.FromSlash(file))
	if rel, err := filepath.Rel(dir, full); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false, false
	}
	f, err := os.Open(full)
	if err != nil {
		return "", false, false
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || st.IsDir() {
		return "", false, false
	}
	raw, err := io.ReadAll(io.LimitReader(f, planCurrentMaxBytes+1))
	if err != nil {
		return "", false, false
	}
	if len(raw) > planCurrentMaxBytes {
		return string(raw[:planCurrentMaxBytes]), true, true
	}
	return string(raw), false, true
}

// planCurrentWorkDir resolves (and caches, see the file header) the werkmap
// this plan's current code is read from. Empty means "no usable checkout" —
// the page then simply shows the proposed code on its own.
func planCurrentWorkDir(ctx context.Context, dataDir, key string) string {
	planCurrentDirMu.Lock()
	entry, ok := planCurrentDirCache[key]
	planCurrentDirMu.Unlock()
	if ok && time.Since(entry.at) < planCurrentDirTTL {
		if entry.dir == "" {
			return ""
		}
		if _, err := os.Stat(filepath.Join(entry.dir, ".git")); err == nil {
			return entry.dir
		}
	}
	dir := resolvePlanCurrentWorkDir(ctx, dataDir, key)
	planCurrentDirMu.Lock()
	planCurrentDirCache[key] = planCurrentDirEntry{dir: dir, at: time.Now()}
	planCurrentDirMu.Unlock()
	return dir
}

// resolvePlanCurrentWorkDir is the uncached half: the plan's own sticky werkmap
// first (the directory plan_execute already put this plan's branch in — which
// is exactly where the current code lives), otherwise the first clean
// candidate of the shared selection ladder.
//
// Unlike resolvePlanWorkDir (plan_execute.go) this never writes the sticky row
// and never refuses a directory: it only READS a file, so a checkout sitting on
// somebody else's branch is still a truthful picture of the repository, and a
// dirty one is arguably the MOST truthful.
func resolvePlanCurrentWorkDir(ctx context.Context, dataDir, key string) string {
	if dir, _, ok := loadPersistedPlanCheckout(dataDir, key); ok {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
	}
	slug := repoSlugFor("")
	base := planDefaultBaseBranch()
	candidates, _ := listCheckoutCandidates(ctx, dataDir, slug, base, base, checkoutHoldback{})
	for _, c := range candidates {
		if c.Dir != "" {
			return c.Dir
		}
	}
	return ""
}
