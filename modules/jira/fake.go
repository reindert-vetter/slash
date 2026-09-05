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
	notifs []Notification
	Calls  []string // keys requested, in order
	// VerifyErr, if set, is what VerifyCredentials returns — lets a test
	// exercise checkJiraToken's "credentials rejected" branch without a real
	// HTTP call. nil (the default) means "credentials accepted".
	VerifyErr error
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

// SetNotifications programs the list Notifications returns.
func (f *Fake) SetNotifications(list []Notification) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notifs = list
}

// Notifications returns the programmed feed (empty by default, so an offline
// run simply has no Jira notifications rather than an error).
func (f *Fake) Notifications(_ context.Context, limit int) ([]Notification, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if limit > 0 && limit < len(f.notifs) {
		return append([]Notification(nil), f.notifs[:limit]...), nil
	}
	return append([]Notification(nil), f.notifs...), nil
}

// VerifyCredentials returns the programmed VerifyErr (nil by default).
func (f *Fake) VerifyCredentials(_ context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.VerifyErr
}
