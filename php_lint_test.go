package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// phpLintRepo builds a git repo with one staged PHP and one staged non-PHP
// file, plus (when ecsScript != "") a fake vendor/bin/ecs.
func phpLintRepo(t *testing.T, ecsScript string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	if ecsScript != "" {
		bin := filepath.Join(dir, "vendor", "bin")
		if err := os.MkdirAll(bin, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, "ecs"), []byte("#!/bin/sh\n"+ecsScript), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("vendor/\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range map[string]string{"app/Foo.php": "<?php\n", "readme.md": "x\n"} {
		p := filepath.Join(dir, name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("add", "-A")
	return dir
}

func stagedContent(t *testing.T, dir, file string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "show", ":"+file).Output()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// The fake ECS rewrites every path it is handed; its args are written to a
// file so the test can see only the PHP file was passed.
const fakeECSFix = `for a in "$@"; do case "$a" in *.php) echo "// fixed" >> "$a";; esac; done
echo "$@" > ecs-args.txt
exit 0
`

func TestFixStagedPHPStyleFixesAndRestages(t *testing.T) {
	dir := phpLintRepo(t, fakeECSFix)
	if note := fixStagedPHPStyle(context.Background(), dir); note != "" {
		t.Fatalf("unexpected note: %q", note)
	}
	if got := stagedContent(t, dir, "app/Foo.php"); !strings.Contains(got, "// fixed") {
		t.Fatalf("fix not staged: %q", got)
	}
	args, _ := os.ReadFile(filepath.Join(dir, "ecs-args.txt"))
	if !strings.Contains(string(args), "check --fix") || !strings.Contains(string(args), "app/Foo.php") || strings.Contains(string(args), "readme.md") {
		t.Fatalf("unexpected ecs args: %q", args)
	}
}

func TestFixStagedPHPStyleReportsUnfixable(t *testing.T) {
	dir := phpLintRepo(t, "echo 'Found 1 error that needs to be fixed manually'\nexit 1\n")
	note := fixStagedPHPStyle(context.Background(), dir)
	if !strings.Contains(note, "ECS") || !strings.Contains(note, "fixed manually") {
		t.Fatalf("expected a note quoting ECS output, got %q", note)
	}
}

func TestFixStagedPHPStyleNoECSIsNoop(t *testing.T) {
	dir := phpLintRepo(t, "")
	if note := fixStagedPHPStyle(context.Background(), dir); note != "" {
		t.Fatalf("unexpected note: %q", note)
	}
	if got := stagedContent(t, dir, "app/Foo.php"); got != "<?php\n" {
		t.Fatalf("file changed without ecs: %q", got)
	}
}
