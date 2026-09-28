package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
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
	if len(m.Files) >= ghFilesPageSize {
		// `gh pr view --json files` stops at ONE page (100 files) and says
		// nothing about it, so a big PR silently ingested only its first 100
		// changed files — every block in file 101+ was simply missing from the
		// review tree, with no error anywhere. Only pay for the extra call
		// when the list is exactly page-sized, i.e. when it may be truncated.
		if files, err := fetchPRFilesPaged(ctx, repo, pr); err == nil && len(files) > len(m.Files) {
			m.Files = files
		}
	}
	return &m, nil
}

// ghFilesPageSize is GitHub's per-page cap for a PR's changed-file list, and
// therefore the count at which `gh pr view --json files` may be truncated.
const ghFilesPageSize = 100

// fetchPRFilesPaged reads a PR's COMPLETE changed-file list through the REST
// API, which — unlike `gh pr view` — paginates. The REST field names differ
// (`filename` instead of `path`), so this cannot reuse prFile's own tags.
func fetchPRFilesPaged(ctx context.Context, repo string, pr int) ([]prFile, error) {
	cmd := exec.CommandContext(ctx, "gh", "api", "--paginate", "--slurp",
		fmt.Sprintf("repos/%s/pulls/%d/files?per_page=%d", repoSlugFor(repo), pr, ghFilesPageSize))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("gh api pulls/%d/files%s: %w: %s", pr, repoTag(repo), err, msg)
		}
		return nil, fmt.Errorf("gh api pulls/%d/files%s: %w", pr, repoTag(repo), err)
	}
	return parsePRFilesPages(out)
}

// parsePRFilesPages turns `gh api --paginate --slurp` output into prFiles.
// --slurp wraps every page's own array in one outer array, and the REST field
// names differ from `gh pr view`'s (`filename`, not `path`), so this cannot
// reuse prFile's own json tags. Split out of fetchPRFilesPaged so it is
// testable without gh.
func parsePRFilesPages(out []byte) ([]prFile, error) {
	var pages [][]struct {
		Filename  string `json:"filename"`
		Additions int    `json:"additions"`
		Deletions int    `json:"deletions"`
	}
	if err := json.Unmarshal(out, &pages); err != nil {
		return nil, fmt.Errorf("parse pr files: %w", err)
	}
	var files []prFile
	for _, page := range pages {
		for _, f := range page {
			files = append(files, prFile{Path: f.Filename, Additions: f.Additions, Deletions: f.Deletions})
		}
	}
	return files, nil
}

// ensureCommits makes sure both the base and head SHA are present locally.
//
// Both SHAs already reachable → no network at all. That is the common case
// for the ingest-refresh a landed chat edit triggers (refreshTreeAfterLanding,
// chat_merge.go): the head is a LOCAL commit that advancePendingRefFromCheckout
// just fetched into the shared clone, and the base is the one already
// recorded — nothing GitHub could add. The two unconditional fetches below
// were the largest single share of the ~8s that refresh took before the
// reviewer saw his own edit (measured 2026-09-21, PR 13810), on top of the
// landing's own `git fetch origin <branch>` in commitCheckoutEditsAt.
func ensureCommits(ctx context.Context, repo string, pr int, baseSHA, headSHA string) error {
	if commitExists(ctx, repo, baseSHA) && commitExists(ctx, repo, headSHA) {
		return nil
	}
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

// mergeBaseSHA resolves the commit a PR's diff must actually be taken FROM:
// the merge base of the base branch and the head, not the current tip of that
// base branch. `gh pr view --json baseRefOid` reports that tip, so diffing it
// against the head (a two-dot diff) also reports every change the base branch
// received AFTER the PR branched off — as a DELETION, because the PR's head
// simply doesn't have it yet. Reviewer-reported symptom: a translation key
// added to develop showed up as removed in an unrelated PR touching the same
// file. GitHub's own "Files changed" uses the merge base (a three-dot diff),
// which is why this only ever disagreed with the UI over there.
//
// Best-effort: any failure (commit not reachable locally, shallow clone) returns
// baseSHA unchanged, so an ingest never fails harder than it did before. Call it
// AFTER ensureCommits — the merge base is only computable once both commits are
// present locally.
//
// Idempotent by construction: the merge base is an ancestor of head, so
// re-resolving an already-resolved base returns it unchanged. refreshIngestDelta
// relies on that (one of its callers passes the stored, already-resolved base).
func mergeBaseSHA(ctx context.Context, repo string, baseSHA, headSHA string) string {
	out, err := runGitFor(ctx, repo, "merge-base", baseSHA, headSHA)
	if err != nil {
		log.Printf("merge-base %s %s failed (using base as-is): %v", short(baseSHA), short(headSHA), err)
		return baseSHA
	}
	mb := strings.TrimSpace(string(out))
	if mb == "" {
		return baseSHA
	}
	return mb
}

// isAncestor reports whether ancestorSHA is part of descendantSHA's history —
// i.e. whether a plain `prevHead..headSHA` diff is even a meaningful "what
// changed since the last refresh" question. A rebase or a force-push can
// rewrite a PR branch's commits without necessarily moving the resolved merge
// base (see mergeBaseSHA) — e.g. squashing/reordering the PR's own commits
// onto the same base tip — which leaves the previously-recorded head
// unreachable from the new one even though refreshIngestDelta's other guard
// (baseSHA != prevBase) sees no change at all. Diffing two commits with no
// ancestry relationship is not wrong in the git sense (it always produces
// *some* result), but "since" no longer means anything, so the caller treats
// a false answer here as "don't trust a delta, do a full re-ingest instead".
// Best-effort/conservative: any git failure (the object not resolvable
// locally, an actual git error) is treated as "not an ancestor" — the safer
// of the two possible wrong answers, since it only costs an extra full
// ingest, never a silently incomplete delta.
func isAncestor(ctx context.Context, repo, ancestorSHA, descendantSHA string) bool {
	_, err := runGitFor(ctx, repo, "merge-base", "--is-ancestor", ancestorSHA, descendantSHA)
	return err == nil
}

func commitExists(ctx context.Context, repo string, sha string) bool {
	_, err := runGitFor(ctx, repo, "cat-file", "-e", sha+"^{commit}")
	return err == nil
}

// isBadObjectErr recognizes git's "fatal: bad object <sha>" failure — the
// symptom of a commit that `commitExists` (ensureCommits) found reachable but
// that a LATER command (the actual diff) can't resolve after all. Observed on
// plug-and-pay PRs 13535/13628 against a partial-clone checkout of
// ~/dev/plug-and-pay: `git cat-file -e <sha>^{commit}` can succeed via the
// promisor remote's on-demand object fetch, yet a second on-demand fetch
// triggered moments later by `git diff`/`git diff --name-status` fails (flaky
// network, a raced concurrent lazy-fetch, or similar) — so "the object is
// reachable" was never a durable fact, just true at the moment it was
// checked. Not proven live (this exact failure wasn't reproduced in this
// session — a partial clone is hard to set up on demand — but this matches
// the reported error text and the ensureCommits/diffBetweenSHAs call order
// exactly).
func isBadObjectErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "bad object")
}

// badObjectRetryAttempts is how many extra re-fetch-and-retry rounds
// retryAfterRefetch performs after the first failure, on top of the original
// attempt made by the caller (diffBetweenSHAs/detectRenames) before ever
// calling in here. Plugged as a var, not a const, so a test can shrink it.
//
// Raised from 1 to 3: a single retry assumes the object becomes fetchable
// again almost immediately, but a just-pushed/just-merged commit can lag
// GitHub's own replication by more than that. See "commitExists can say yes
// and the diff still fails" in .claude/docs/blocks-and-ingest.md — including
// the PR 29 (plug-and-pay-ops) case that first prompted this, which turned
// out NOT to be replication lag at all but a separate bug (an Activity
// argument silently dropping Repo, so git ran against the wrong repo
// entirely — no amount of retrying here would have helped that one).
var badObjectRetryAttempts = 3

// badObjectRetryBackoff is the pause between rounds. Short and fixed — this
// runs inside a tembed Activity (time.Sleep is fine there, see
// .claude/rules/workflow-determinism.md: only the *workflow* body itself must
// stay side-effect-free and non-blocking, an Activity may legitimately take
// real wall-clock time), but the whole ingest pipeline must not stall for
// long on a genuinely missing object. Plugged as a var so a test can shrink
// it to keep the suite fast.
var badObjectRetryBackoff = 300 * time.Millisecond

// retryAfterRefetch re-fetches both SHAs by exact object id (the same
// fallback ensureCommits already uses when commitExists first comes back
// false) and retries the given git command, up to badObjectRetryAttempts
// extra rounds with a short backoff in between. It only keeps retrying while
// the retried command itself still fails with isBadObjectErr — a genuinely
// missing/invalid SHA fails the same way on every round and the last error is
// returned once the attempts are exhausted, same as before this only ever ran
// once. Used by diffBetweenSHAs and detectRenames as a defensive recovery
// from isBadObjectErr — see its doc comment for why a commit that passed
// ensureCommits can still fail here.
func retryAfterRefetch(ctx context.Context, repo, baseSHA, headSHA string, args []string) ([]byte, error) {
	var out []byte
	var err error
	for attempt := 1; attempt <= badObjectRetryAttempts; attempt++ {
		var fetchErr error
		for _, sha := range []string{baseSHA, headSHA} {
			if _, ferr := runGitFor(ctx, repo, "fetch", "origin", sha); ferr != nil {
				fetchErr = ferr
			}
		}
		if fetchErr != nil {
			log.Printf("retryAfterRefetch: re-fetch failed (attempt %d/%d), retrying diff anyway: %v", attempt, badObjectRetryAttempts, fetchErr)
		}
		out, err = runGitFor(ctx, repo, args...)
		if !isBadObjectErr(err) {
			return out, err
		}
		if attempt < badObjectRetryAttempts {
			log.Printf("retryAfterRefetch: still bad object after attempt %d/%d, backing off: %v", attempt, badObjectRetryAttempts, err)
			time.Sleep(badObjectRetryBackoff)
		}
	}
	return out, err
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
	if isBadObjectErr(err) {
		out, err = retryAfterRefetch(ctx, repo, baseSHA, headSHA, args)
	}
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
	args := []string{"diff", "--find-renames", "--name-status", baseSHA, headSHA}
	out, err := runGitFor(ctx, repo, args...)
	if isBadObjectErr(err) {
		out, err = retryAfterRefetch(ctx, repo, baseSHA, headSHA, args)
	}
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

// fetchBaseRefChange reads the PR's current target branch and, when that target
// was ever changed on GitHub, the branch it was changed FROM (the most recent
// BaseRefChangedEvent's previousRefName; "" when it never changed). Read-only
// (one GraphQL query), used by the fetchPRBasics Activity to store it into the
// prmeta read-model and by prSummaryRefreshNeeded to notice a change — the PR
// info column shows "old → new" so a reviewer sees why the tree's left side
// moved. Never touches the network under SLASH_GITHUB=off.
func fetchBaseRefChange(ctx context.Context, repo string, pr int) (current, previous string, err error) {
	if ghDisabled() {
		return "", "", fmt.Errorf("github disabled")
	}
	owner, name, ok := splitSlug(repoSlugFor(repo))
	if !ok {
		return "", "", fmt.Errorf("bad repo slug %q", repoSlugFor(repo))
	}
	const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){` +
		`baseRefName timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT],last:1){nodes{` +
		`... on BaseRefChangedEvent{previousRefName currentRefName}}}}}}`
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql", "-f", "query="+q,
		"-f", "o="+owner, "-f", "n="+name, "-F", "p="+strconv.Itoa(pr))
	out, err := cmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("gh base ref change pr %d%s: %w", pr, repoTag(repo), err)
	}
	var resp struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					BaseRefName   string `json:"baseRefName"`
					TimelineItems struct {
						Nodes []struct {
							PreviousRefName string `json:"previousRefName"`
						} `json:"nodes"`
					} `json:"timelineItems"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return "", "", fmt.Errorf("parse base ref change: %w", err)
	}
	p := resp.Data.Repository.PullRequest
	current = p.BaseRefName
	if n := p.TimelineItems.Nodes; len(n) > 0 && n[len(n)-1].PreviousRefName != current {
		previous = n[len(n)-1].PreviousRefName
	}
	return current, previous, nil
}
