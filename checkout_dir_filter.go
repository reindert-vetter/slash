package main

import (
	"path/filepath"
	"strings"
)

// isWorktreesCheckoutDir reports whether dir lies inside a `*.worktrees`
// directory (any path segment ending in ".worktrees", e.g.
// ~/dev/plug-and-pay.worktrees/BUG-1). Such git worktrees are never offered
// or reused as a werkmap for edits; this applies to discovered, configured
// (chatCheckoutDirs) and previously persisted directories alike.
func isWorktreesCheckoutDir(dir string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(filepath.Clean(dir)), "/") {
		if strings.HasSuffix(seg, ".worktrees") {
			return true
		}
	}
	return false
}
