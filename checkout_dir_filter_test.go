package main

import (
	"path/filepath"
	"testing"
)

func TestIsWorktreesCheckoutDir(t *testing.T) {
	for dir, want := range map[string]bool{
		"/Users/x/dev/plug-and-pay.worktrees/BUG-1": true,
		"/Users/x/dev/plug-and-pay.worktrees":       true,
		"/Users/x/dev/plug-and-pay-2":               false,
		"/Users/x/dev/worktrees-foo/a":              false,
	} {
		if got := isWorktreesCheckoutDir(dir); got != want {
			t.Errorf("%s: got %v want %v", dir, got, want)
		}
	}
}

func TestPersistedCheckoutInWorktreesDirIsIgnored(t *testing.T) {
	dataDir := t.TempDir()
	wt := filepath.Join(dataDir, "repo.worktrees", "BUG-1")
	savePersistedCheckout(dataDir, "o/r", 7, wt, "b")
	savePersistedPlanCheckout(dataDir, "K-1", wt, "b")
	if _, _, ok := loadPersistedCheckout(dataDir, "o/r", 7); ok {
		t.Error("PR checkout in .worktrees should be ignored")
	}
	if _, _, ok := loadPersistedPlanCheckout(dataDir, "K-1"); ok {
		t.Error("plan checkout in .worktrees should be ignored")
	}
	ok1 := filepath.Join(dataDir, "repo-2")
	savePersistedCheckout(dataDir, "o/r", 8, ok1, "b")
	if d, _, ok := loadPersistedCheckout(dataDir, "o/r", 8); !ok || d != ok1 {
		t.Error("normal dir must still load")
	}
}
