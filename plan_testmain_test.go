package main

import (
	"os"
	"testing"
)

// TestMain keeps every test off the machine's real checkouts: planGenerate now
// resolves the plan's werkmap (resolvePlanChatWorkDir), and without this the
// home-directory scan would find the reviewer's real clones and `git fetch`
// them. A test that wants a specific home sets its own SLASH_CHECKOUT_HOME_DIR.
func TestMain(m *testing.M) {
	if os.Getenv("SLASH_CHECKOUT_HOME_DIR") == "" {
		if dir, err := os.MkdirTemp("", "slash-test-home-"); err == nil {
			os.Setenv("SLASH_CHECKOUT_HOME_DIR", dir)
			defer os.RemoveAll(dir)
		}
	}
	os.Exit(m.Run())
}
