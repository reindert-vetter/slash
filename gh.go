package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// repoDir is the local clone of plug-and-pay/plug-and-pay.
const repoDir = "/Users/reindert/dev/plug-and-pay"

// repoSlug for gh --repo.
const repoSlug = "plug-and-pay/plug-and-pay"

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
}

// runGit runs a git command in repoDir with separate args + context timeout.
func runGit(ctx context.Context, args ...string) ([]byte, error) {
	full := append([]string{"-C", repoDir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// fetchPRMeta retrieves the PR metadata via gh.
func fetchPRMeta(ctx context.Context, pr int) (*prMeta, error) {
	cmd := exec.CommandContext(ctx, "gh", "pr", "view", strconv.Itoa(pr),
		"--repo", repoSlug, "--json", "files,baseRefOid,headRefOid,baseRefName")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh pr view %d: %w", pr, err)
	}
	var m prMeta
	if err := json.Unmarshal(out, &m); err != nil {
		return nil, fmt.Errorf("parse pr meta: %w", err)
	}
	return &m, nil
}

// ensureCommits makes sure both the base and head SHA are present locally.
func ensureCommits(ctx context.Context, pr int, baseSHA, headSHA string) error {
	// Head via the pull ref (most reliable), base via develop.
	_, _ = runGit(ctx, "fetch", "origin", fmt.Sprintf("refs/pull/%d/head", pr))
	_, _ = runGit(ctx, "fetch", "origin", "develop")

	for _, sha := range []string{baseSHA, headSHA} {
		if !commitExists(ctx, sha) {
			// Fallback: fetch explicitly by SHA (GitHub allows this).
			if _, err := runGit(ctx, "fetch", "origin", sha); err != nil {
				return fmt.Errorf("cannot fetch commit %s: %w", short(sha), err)
			}
		}
		if !commitExists(ctx, sha) {
			return fmt.Errorf("commit %s still unresolvable after fetch", short(sha))
		}
	}
	return nil
}

func commitExists(ctx context.Context, sha string) bool {
	_, err := runGit(ctx, "cat-file", "-e", sha+"^{commit}")
	return err == nil
}

// ensureWorktree creates (idempotently) a detached worktree at sha in dir.
func ensureWorktree(ctx context.Context, dir, sha string) error {
	// Path already a worktree? Remove and rebuild for a clean state.
	_, _ = runGit(ctx, "worktree", "remove", "--force", dir)
	if _, err := runGit(ctx, "worktree", "add", "--detach", dir, sha); err != nil {
		return err
	}
	return nil
}

// diffBetweenSHAs returns the unified diff between two commits, limited to files.
func diffBetweenSHAs(ctx context.Context, baseSHA, headSHA string, files []string) (string, error) {
	args := []string{"diff", "--no-color", "--unified=0", baseSHA, headSHA, "--"}
	args = append(args, files...)
	out, err := runGit(ctx, args...)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func short(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}
