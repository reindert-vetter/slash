package main

import (
	"context"
	"log"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// alignedSubmodules lists the submodules slash keeps on the TARGET's pointer
// (the base branch's recorded commit) in every checkout it works in, so a
// differing submodule never counts as a deviation, a dirty work directory or
// an accidental pointer bump. Extend the list to cover more submodules.
var alignedSubmodules = []string{"modules/Ai"}

var gitSHAPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// submoduleTargetSHA reads the commit origin/<base> records for submodule path.
// ok=false when base has no gitlink there (or the ref is unknown).
func submoduleTargetSHA(ctx context.Context, dir, base, path string) (string, bool) {
	out, err := runGitStdoutIn(ctx, dir, "ls-tree", "origin/"+base, "--", path)
	if err != nil {
		return "", false
	}
	// "160000 commit <sha>\t<path>"
	fields := strings.Fields(string(out))
	if len(fields) < 3 || fields[0] != "160000" || !gitSHAPattern.MatchString(fields[2]) {
		return "", false
	}
	return fields[2], true
}

// alignSubmodulesToTarget moves every aligned submodule's work tree onto the
// commit origin/<base> records, fetching exactly that sha when it is missing
// locally. It touches ONLY the submodule directories — never the rest of dir —
// and is best-effort: a broken submodule remote or a submodule with its own
// uncommitted work is logged and skipped, never an error for the caller.
func alignSubmodulesToTarget(ctx context.Context, dir, base string) {
	if strings.TrimSpace(base) == "" {
		return
	}
	for _, path := range alignedSubmodules {
		sha, ok := submoduleTargetSHA(ctx, dir, base, path)
		if !ok {
			continue
		}
		sub := filepath.Join(dir, path)
		if cur, err := runGitStdoutIn(ctx, sub, "rev-parse", "HEAD"); err == nil && strings.TrimSpace(string(cur)) == sha {
			continue
		}
		stepCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		err := alignOneSubmodule(stepCtx, dir, sub, path, sha)
		cancel()
		if err != nil {
			log.Printf("submodule_align: %s in %s: %v", path, dir, err)
		}
	}
}

func alignOneSubmodule(ctx context.Context, dir, sub, path, sha string) error {
	// Not initialised yet (no .git inside): init it without recursing.
	if _, err := runGitStdoutIn(ctx, sub, "rev-parse", "--git-dir"); err != nil {
		if _, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "submodule", "update", "--init", "--no-recurse-submodules", "--", path); err != nil {
			return err
		}
	}
	if _, err := runGitIn(ctx, sub, "cat-file", "-e", sha+"^{commit}"); err != nil {
		if _, err := runGitIn(ctx, sub, "fetch", "--no-recurse-submodules", "origin", sha); err != nil {
			return err
		}
	}
	// Plain checkout, no -f: a submodule carrying its own uncommitted work is
	// left alone and reported.
	_, err := runGitIn(ctx, sub, "checkout", "--detach", sha)
	return err
}

// unstageSubmodulePointers puts every aligned submodule's INDEX entry back on
// what HEAD records, so a commit slash or Claude makes through `add -A` never
// carries a submodule bump. Call it between staging and committing.
func unstageSubmodulePointers(ctx context.Context, dir string) {
	for _, path := range alignedSubmodules {
		if _, err := runGitIn(ctx, dir, "reset", "-q", "HEAD", "--", path); err != nil {
			log.Printf("submodule_align: unstage %s in %s: %v", path, dir, err)
		}
	}
}
