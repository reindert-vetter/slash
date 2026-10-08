package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestQACheckoutGuardRestoresOnlyTheRunsOwnChanges: a temp repo with a
// pre-existing user change (modified + untracked); the "run" adds files,
// modifies a clean tracked file, deletes one, stages one, and also touches the
// user's own modified file. Afterwards every run change is gone and the user's
// changes are exactly as before.
func TestQACheckoutGuardRestoresOnlyTheRunsOwnChanges(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return string(out)
	}
	write := func(p, s string) {
		t.Helper()
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	read := func(p string) string {
		b, err := os.ReadFile(filepath.Join(dir, p))
		if err != nil {
			return "<missing>"
		}
		return string(b)
	}
	git("init", "-q")
	write("app/a.php", "a\n")
	write("app/b.php", "b\n")
	write("app/c.php", "c\n")
	write("user.php", "user v0\n")
	git("add", "-A")
	git("commit", "-q", "-m", "init")

	// The user's own open work before the run.
	write("user.php", "user v1 (mine)\n")
	write("notes/mine.txt", "my notes\n")
	before := git("status", "--porcelain=v1", "--untracked-files=all")

	ctx := context.Background()
	snap, err := snapshotQACheckout(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}

	// What a misbehaving run does.
	write("data/qa/14116/run/console.log", "log\n") // new file in a new dir
	write("scratch.php", "<?php\n")                // new file
	write("app/a.php", "a changed\n")              // clean tracked file changed
	if err := os.Remove(filepath.Join(dir, "app/b.php")); err != nil {
		t.Fatal(err)
	}
	write("staged-new.php", "x\n")
	git("add", "staged-new.php")
	write("user.php", "user v2 (run)\n") // the user's file touched too

	restored, notes := restoreQACheckout(ctx, dir, snap)
	if len(notes) != 0 {
		t.Fatalf("notes: %v", notes)
	}
	after := git("status", "--porcelain=v1", "--untracked-files=all")
	if after != before {
		t.Fatalf("status differs:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	if got := read("user.php"); got != "user v1 (mine)\n" {
		t.Fatalf("user.php = %q", got)
	}
	if got := read("notes/mine.txt"); got != "my notes\n" {
		t.Fatalf("notes/mine.txt = %q", got)
	}
	if got := read("app/a.php"); got != "a\n" {
		t.Fatalf("app/a.php = %q", got)
	}
	if got := read("app/b.php"); got != "b\n" {
		t.Fatalf("app/b.php = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); !os.IsNotExist(err) {
		t.Fatalf("data/ dir left behind: %v", err)
	}
	joined := strings.Join(restored, "\n")
	for _, want := range []string{"data/qa/14116/run/console.log", "scratch.php", "app/a.php", "app/b.php", "staged-new.php", "user.php"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("restored misses %s: %v", want, restored)
		}
	}
	if !strings.Contains(qaGuardDeviation(restored), "6 bestand(en)") {
		t.Fatalf("deviation: %s", qaGuardDeviation(restored))
	}

	// A clean run reports nothing.
	snap, _ = snapshotQACheckout(ctx, dir)
	if r, n := restoreQACheckout(ctx, dir, snap); len(r) != 0 || len(n) != 0 {
		t.Fatalf("clean run restored %v / %v", r, n)
	}
}
