package main

import (
	"context"
	"time"
)

// The planning chat may test things itself: every turn gets the same tool set
// the QA run has (qa_run.go) — Read/Grep/Glob, a real shell (Bash), the
// Playwright browser and laravel-boost — but NO Edit, in the plan's own sticky
// checkout (resolvePlanWorkDir, the clean werkmap plan_execute also uses).
// Reviewer request: "/plan moet wel die rechten kunnen krijgen". Recorded as a
// carve-out in .claude/rules/workflows-write-boundary.md.

// planChatIdleTimeout is an idle bound (no output), like the QA run's: a docker
// or artisan call can be silent for a while.
const planChatIdleTimeout = 20 * time.Minute

// planChatToolset is the --tools list of one planning-chat turn. Pure, so the
// "no Edit, shell only with a werkmap" contract is unit-testable. Without a
// werkmap (shell false) the turn keeps only what needs none: the attachment
// images and the read-only request-log pattern.
func planChatToolset(shell bool, requestLog string, hasAttachments bool) []string {
	if shell {
		return []string{"Read", "Grep", "Glob", "Bash", "mcp__playwright", "mcp__laravel-boost"}
	}
	var tools []string
	if hasAttachments {
		tools = append(tools, "Read")
	}
	if requestLog != "" {
		tools = append(tools, "Bash(duckdb -readonly "+requestLog+":*)")
	}
	return tools
}

// resolvePlanChatWorkDir returns the plan's own clean checkout for a chat turn:
// the sticky one, else the first free clean one of the shared ladder. There is
// deliberately no fallback to a dirty or foreign checkout; when nothing is
// usable the second result is a reviewer-facing sentence for the prompt.
func resolvePlanChatWorkDir(ctx context.Context, m *TaskManager, doc planDoc) (dir, note string) {
	return resolvePlanWorkDir(ctx, m, doc.Key, "", doc.BaseBranch)
}
