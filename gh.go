package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// repoSlug is the built-in PRIMARY repo for gh --repo: the repo slash was built
// around, and the one a bare PR number/`/pr/<n>` URL/empty repo string refers to.
// Additional repos are configured in settings.json — see repos.go, which also
// explains why the primary repo is represented as the empty string internally.
const repoSlug = "plug-and-pay/plug-and-pay"

// defaultRepoDir is the fallback local clone of plug-and-pay/plug-and-pay when
// SLASH_REPO_DIR is not set. Tilde-expanded via os.UserHomeDir() so it works
// for any user, not just a hardcoded home path.
const defaultRepoDir = "~/dev/plug-and-pay"

// repoDir resolves the local clone path: SLASH_REPO_DIR (env) overrides,
// otherwise defaultRepoDir. A leading "~" is expanded to the user's home dir
// (Go's exec/os do not expand "~" themselves), so SLASH_REPO_DIR=~/dev/foo
// works too.
func repoDir() string {
	dir := repoDirEnv()
	if dir == "" {
		dir = defaultRepoDir
	}
	return expandTilde(dir)
}

// repoDirEnv is the raw SLASH_REPO_DIR override (un-expanded, possibly empty).
// Split out so the repo registry can apply the same override to whichever
// configured entry is the primary repo (see normalizeRepos).
func repoDirEnv() string { return os.Getenv("SLASH_REPO_DIR") }

// expandTilde replaces a leading "~" (bare or "~/…") with the user's home dir.
// On failure to resolve the home dir it returns the path unchanged.
func expandTilde(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if path == "~" {
		return home
	}
	return home + path[1:]
}

// prFile is one changed file from `gh pr view`.
type prFile struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// prMeta is the subset of PR metadata we need.
type prMeta struct {
	Files       []prFile `json:"files"`
	BaseRefOid  string   `json:"baseRefOid"`
	HeadRefOid  string   `json:"headRefOid"`
	BaseRefName string   `json:"baseRefName"`
	// HeadRefName is the PR's real head branch name (e.g. "feature/x") — used
	// by the claude_chat edit path (chat_shadow.go) to check out its
	// per-conversation shadow worktree on a real branch (not detached) and to
	// know which branch to fast-forward-push a commit onto. Not used by the
	// ingest pipeline itself, which pins base/head worktrees to an exact SHA.
	HeadRefName string `json:"headRefName"`
}

// runGit runs a git command in the PRIMARY repo's clone with separate args +
// context timeout. Everything that can concern a second repo calls runGitFor
// instead; this stays as the shorthand for a genuinely primary-repo-only path.
func runGit(ctx context.Context, args ...string) ([]byte, error) {
	return runGitFor(ctx, "", args...)
}

// runGitFor runs a git command in the clone of the given canonical repo string
// ("" = the primary repo, see repos.go).
func runGitFor(ctx context.Context, repo string, args ...string) ([]byte, error) {
	full := append([]string{"-C", repoDirFor(repo)}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// fetchPRMeta retrieves the PR metadata via gh.
func fetchPRMeta(ctx context.Context, repo string, pr int) (*prMeta, error) {
	cmd := exec.CommandContext(ctx, "gh", "pr", "view", strconv.Itoa(pr),
		"--repo", repoSlugFor(repo), "--json", "files,baseRefOid,headRefOid,baseRefName,headRefName")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("gh pr view %d%s: %w: %s", pr, repoTag(repo), err, msg)
		}
		return nil, fmt.Errorf("gh pr view %d%s: %w", pr, repoTag(repo), err)
	}
	var m prMeta
	if err := json.Unmarshal(out, &m); err != nil {
		return nil, fmt.Errorf("parse pr meta: %w", err)
	}
	return &m, nil
}

// ensureCommits makes sure both the base and head SHA are present locally.
func ensureCommits(ctx context.Context, repo string, pr int, baseSHA, headSHA string) error {
	// Head via the pull ref (most reliable), base via the repo's own base branch
	// (the registry's baseBranch: "develop" for plug-and-pay — the historical
	// hardcoded value — "master" for plug-and-pay-ops).
	_, _ = runGitFor(ctx, repo, "fetch", "origin", fmt.Sprintf("refs/pull/%d/head", pr))
	_, _ = runGitFor(ctx, repo, "fetch", "origin", baseBranchFor(repo))

	for _, sha := range []string{baseSHA, headSHA} {
		if !commitExists(ctx, repo, sha) {
			// Fallback: fetch explicitly by SHA (GitHub allows this).
			if _, err := runGitFor(ctx, repo, "fetch", "origin", sha); err != nil {
				return fmt.Errorf("cannot fetch commit %s: %w", short(sha), err)
			}
		}
		if !commitExists(ctx, repo, sha) {
			return fmt.Errorf("commit %s still unresolvable after fetch", short(sha))
		}
	}
	return nil
}

func commitExists(ctx context.Context, repo string, sha string) bool {
	_, err := runGitFor(ctx, repo, "cat-file", "-e", sha+"^{commit}")
	return err == nil
}

// ensureWorktree creates (idempotently) a detached worktree at sha in dir, owned
// by repo's clone.
func ensureWorktree(ctx context.Context, repo, dir, sha string) error {
	// Path already a worktree? Remove and rebuild for a clean state.
	_, _ = runGitFor(ctx, repo, "worktree", "remove", "--force", dir)
	if _, err := runGitFor(ctx, repo, "worktree", "add", "--detach", dir, sha); err != nil {
		return err
	}
	return nil
}

// runGitIn runs a git command inside an arbitrary directory (e.g. a worktree),
// unlike runGit which always operates on the fixed upstream clone (repoDir).
func runGitIn(ctx context.Context, dir string, args ...string) ([]byte, error) {
	full := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	out, err := cmd.CombinedOutput()
	// Feeds the werkmap overlay's live progress panel (checkout_progress.go) —
	// a no-op unless ctx was wrapped via withCheckoutProgress, which only the
	// four checkout-menu Activities (workflows.go) do.
	recordCheckoutProgressGit(ctx, args, out, err)
	if err != nil {
		return out, fmt.Errorf("git %s (in %s): %w: %s", strings.Join(args, " "), dir, err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// showFileAtSHA returns the contents of one file as of a commit, without checking
// anything out. Unlike runGit it captures stdout ONLY — runGit's CombinedOutput
// would splice git's stderr into the file content — and it deliberately returns a
// bare error for a path that didn't exist at that revision, which callers treat as
// "no old side to compare against" rather than a failure.
//
// Used by the re-anchor pass (reanchor.go) to rebuild the aligned-row space an
// approval was written in: the head worktree has by then already been checked out
// to the new SHA in place (updateWorktree below), so the previous sides are only
// still reachable through git.
func showFileAtSHA(ctx context.Context, repo, sha, path string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", repoDirFor(repo), "show", sha+":"+path)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git show %s:%s: %w", sha, path, err)
	}
	return out, nil
}

// updateWorktree points an existing worktree at dir to sha in place (a
// detached checkout inside that worktree), avoiding ensureWorktree's full
// remove+recreate. The ingest-refresh path (refreshIngestDelta) runs on every
// poll tick a new head SHA is observed, so re-registering the worktree from
// scratch each time would be wasteful; falls back to ensureWorktree when the
// in-place update fails (dir missing, not yet a worktree, or corrupted).
func updateWorktree(ctx context.Context, repo, dir, sha string) error {
	if _, err := os.Stat(dir); err == nil {
		if _, err := runGitIn(ctx, dir, "checkout", "--detach", sha); err == nil {
			return nil
		}
	}
	return ensureWorktree(ctx, repo, dir, sha)
}

// diffBetweenSHAs returns the unified diff between two commits, limited to files.
// Rename detection is on (--find-renames, git's default -M ~50% threshold): a
// moved file is emitted as one rename entry keyed on the new path, so a
// renamed-and-edited file's changed old/new line numbers pair up under that
// new path in parseUnifiedDiff. For this to fire the caller must include BOTH
// the new and the old path in files (a pathspec limited to only the new path
// would filter out the deletion of the old path before git can pair them).
func diffBetweenSHAs(ctx context.Context, repo, baseSHA, headSHA string, files []string) (string, error) {
	args := []string{"diff", "--no-color", "--find-renames", "--unified=0", baseSHA, headSHA, "--"}
	args = append(args, files...)
	out, err := runGitFor(ctx, repo, args...)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// detectRenames returns a map of new-path -> old-path for every file the PR
// moved that git detects as a rename (default -M ~50% similarity threshold),
// via `git diff --find-renames --name-status`. A move git does NOT recognize
// as a rename (too much content changed) is absent here and stays a plain
// delete+add — the accepted "als dat even kan" boundary
// (.claude/docs/blocks-and-ingest.md). Best-effort caller: on error the full
// ingest just proceeds with no rename pairing.
func detectRenames(ctx context.Context, repo, baseSHA, headSHA string) (map[string]string, error) {
	out, err := runGitFor(ctx, repo, "diff", "--find-renames", "--name-status", baseSHA, headSHA)
	if err != nil {
		return nil, err
	}
	renames := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		// A rename row is "R<score>\t<old>\t<new>" (tab-separated).
		if len(line) == 0 || line[0] != 'R' {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) >= 3 && fields[1] != "" && fields[2] != "" {
			renames[fields[2]] = fields[1] // new -> old
		}
	}
	return renames, nil
}

// changedFileNames returns the file paths that differ between two commits (no
// path filter) — cheaper than a full unified diff when only the file list is
// needed. Used by the ingest-refresh path to discover exactly which files
// changed since the previously ingested head SHA. Rename detection is
// explicitly disabled (--no-renames): with it on (the default for `git diff`
// on modern git), a renamed file's --name-only output collapses to just the
// new path, dropping the old one from the delta entirely. refreshIngestDelta
// scopes its DELETE to exactly this file list (upsertPRFileBlocks), so a
// dropped old path leaves that file's stale blocks behind forever — orphaned
// rows for a file that no longer exists on the PR's head. Listing both the
// old (deleted) and new (added) path lets that DELETE clean up the old rows
// like any other real removal.
func changedFileNames(ctx context.Context, repo, oldSHA, newSHA string) ([]string, error) {
	out, err := runGitFor(ctx, repo, "diff", "--no-renames", "--name-only", oldSHA, newSHA)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

func short(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}
