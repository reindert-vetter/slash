package main

import (
	"bytes"
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// phpStyleFixTimeout bounds one ECS run. ECS on a handful of files takes a
// few seconds; the bound only exists so a hung php process can never stall a
// commit.
const phpStyleFixTimeout = 90 * time.Second

// phpStyleFixMaxOutput caps how much of ECS's own output is quoted back in the
// note shown to the reviewer.
const phpStyleFixMaxOutput = 600

// fixStagedPHPStyle runs plug-and-pay's own style checker (ECS, the
// `php-style-check` job of its run-linter.yml GitHub Action) with --fix on the
// staged .php files of dir, and re-stages whatever it rewrote. Called right
// before every commit slash itself makes in a plug-and-pay checkout (chat
// edit, plan execution, plan self-review), because that style job is what
// fails a PR's Linter check almost every time.
//
// Best-effort by design: the commit always goes ahead. It is a silent no-op
// when nothing PHP is staged or the checkout has no vendor/bin/ecs (a non-PHP
// repo, a fixture). The returned note is non-empty only when ECS crashed or
// left errors it could not fix — Dutch, reviewer-facing, for the caller to
// show next to its own outcome.
func fixStagedPHPStyle(ctx context.Context, dir string) string {
	ecs := filepath.Join(dir, "vendor", "bin", "ecs")
	if _, err := os.Stat(ecs); err != nil {
		return ""
	}
	out, err := runGitStdoutIn(ctx, dir, "diff", "--cached", "--name-only", "-z", "--diff-filter=d", "--", "*.php")
	if err != nil {
		log.Printf("php lint: list staged files in %s: %v", dir, err)
		return ""
	}
	var files []string
	for _, f := range strings.Split(string(out), "\x00") {
		if f != "" {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		return ""
	}

	runCtx, cancel := context.WithTimeout(ctx, phpStyleFixTimeout)
	defer cancel()
	args := append([]string{"check", "--fix", "--no-progress-bar", "--no-diffs", "--"}, files...)
	cmd := exec.CommandContext(runCtx, ecs, args...)
	cmd.Dir = dir
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	runErr := cmd.Run()

	// Re-stage even after a failed run: a partial fix is still a fix.
	addArgs := append([]string{"add", "--"}, files...)
	if _, err := runGitInRetryOnLock(ctx, dir, addArgs...); err != nil {
		log.Printf("php lint: re-stage in %s: %v", dir, err)
	}
	if runErr == nil {
		return ""
	}
	log.Printf("php lint: ecs in %s: %v", dir, runErr)
	detail := strings.TrimSpace(buf.String())
	if len(detail) > phpStyleFixMaxOutput {
		detail = "…" + detail[len(detail)-phpStyleFixMaxOutput:]
	}
	if detail == "" {
		detail = runErr.Error()
	}
	return "Let op: de PHP-linter (ECS) kon niet alles automatisch oplossen; de Linter-check van de PR kan hierop falen. Uitvoer: " + detail
}
