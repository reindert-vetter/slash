package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitT(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{"-C", dir, "-c", "protocol.file.allow=always", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"}, args...)
	out, err := exec.Command("git", full...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// Scenario from STAT-1155: the plan checkout sits on a branch whose submodule
// pointer differs from the base's. After checkout -B origin/<base> the
// submodule work tree must follow the base, and a commit must not carry a bump.
func TestAlignSubmodulesToTargetAndNoBump(t *testing.T) {
	old := alignedSubmodules
	alignedSubmodules = []string{"modules/Ai"}
	defer func() { alignedSubmodules = old }()
	ctx := context.Background()
	root := t.TempDir()

	subSrc := filepath.Join(root, "ai-src")
	_ = os.MkdirAll(subSrc, 0o755)
	gitT(t, subSrc, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(subSrc, "a"), []byte("1"), 0o644)
	gitT(t, subSrc, "add", "-A")
	gitT(t, subSrc, "commit", "-qm", "one")
	sha1 := gitT(t, subSrc, "rev-parse", "HEAD")
	os.WriteFile(filepath.Join(subSrc, "a"), []byte("2"), 0o644)
	gitT(t, subSrc, "commit", "-qam", "two")
	sha2 := gitT(t, subSrc, "rev-parse", "HEAD")

	seed := filepath.Join(root, "seed")
	_ = os.MkdirAll(seed, 0o755)
	gitT(t, seed, "init", "-q", "-b", "main")
	gitT(t, seed, "submodule", "add", "-q", subSrc, "modules/Ai")
	gitT(t, seed+"/modules/Ai", "checkout", "-q", sha1)
	gitT(t, seed, "add", "-A")
	gitT(t, seed, "commit", "-qm", "base at sha1")
	// A feature branch bumping the pointer to sha2.
	gitT(t, seed, "checkout", "-qb", "feature")
	gitT(t, seed+"/modules/Ai", "checkout", "-q", sha2)
	gitT(t, seed, "add", "-A")
	gitT(t, seed, "commit", "-qm", "bump")
	gitT(t, seed, "checkout", "-q", "main")

	work := filepath.Join(root, "work")
	gitT(t, root, "clone", "-q", "--recurse-submodules", seed, work)
	gitT(t, work, "checkout", "-q", "-B", "plan", "origin/feature")
	gitT(t, work+"/modules/Ai", "checkout", "-q", sha2)

	// Plan flow: checkout -B from the base, then align.
	gitT(t, work, "-c", "submodule.recurse=false", "checkout", "-q", "-B", "plan", "origin/main")
	alignSubmodulesToTarget(ctx, work, "main")
	if got := gitT(t, work+"/modules/Ai", "rev-parse", "HEAD"); got != sha1 {
		t.Fatalf("submodule at %s, want base pointer %s", got, sha1)
	}

	// Simulate a stray bump staged next to real work: it must not be committed.
	os.WriteFile(filepath.Join(work, "real.txt"), []byte("x"), 0o644)
	gitT(t, work+"/modules/Ai", "checkout", "-q", sha2)
	gitT(t, work, "add", "-A")
	unstageSubmodulePointers(ctx, work)
	gitT(t, work, "commit", "-qm", "work")
	if out := gitT(t, work, "show", "--stat", "--format=", "HEAD"); strings.Contains(out, "modules/Ai") {
		t.Fatalf("commit carried a submodule bump:\n%s", out)
	}
}
