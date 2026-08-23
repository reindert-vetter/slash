package jira

import (
	"context"
	"sync"
)

// Fake is an in-memory Client for tests and offline runs (SLASH_JIRA=off). It
// returns whatever Issue was programmed for a key; an unprogrammed key returns
// a zero Issue and no error (best-effort, mirrors a "not found" case).
type Fake struct {
	mu     sync.Mutex
	issues map[string]Issue
	Calls  []string // keys requested, in order
}

// SetIssue programs Issue to return issue for key.
func (f *Fake) SetIssue(key string, issue Issue) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.issues == nil {
		f.issues = map[string]Issue{}
	}
	f.issues[key] = issue
}

// Issue returns the programmed issue for key (zero value if none was set).
func (f *Fake) Issue(_ context.Context, key string) (Issue, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, key)
	return f.issues[key], nil
}
