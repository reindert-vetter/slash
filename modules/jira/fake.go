package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// Fake is an in-memory Client for tests and offline runs (SLASH_JIRA=off). It
// returns whatever Issue was programmed for a key; an unprogrammed key returns
// a zero Issue and no error (best-effort, mirrors a "not found" case).
type Fake struct {
	mu     sync.Mutex
	issues map[string]Issue
	notifs []Notification
	// search is what Search returns per JQL string; an unprogrammed query
	// returns nothing, so an offline run simply has no issues rather than an
	// error (same best-effort shape as issues/notifs above).
	search map[string][]Issue
	// sprints is what IssueSprints returns per issue key; an unprogrammed key
	// has no sprint, which is a legitimate answer (see sprints.go).
	sprints map[string][]Sprint
	// SearchCalls records every JQL Search was asked for, in order.
	SearchCalls []string
	Calls       []string // keys requested, in order
	// VerifyErr, if set, is what VerifyCredentials returns — lets a test
	// exercise checkJiraToken's "credentials rejected" branch without a real
	// HTTP call. nil (the default) means "credentials accepted".
	VerifyErr error
	// Posted records every comment AddComment was asked to post, in order, so
	// a test can assert the ADF that reached Jira without a network.
	Posted []PostedComment
	// PostErr, if set, is what AddComment returns instead of posting.
	PostErr error
	// users is what Users returns for any query (a fake never searches).
	users []User
	// Transitions records every Transition call, in order, so a test can
	// assert which issue was moved to which status without touching Jira.
	Transitions []TransitionCall
	// TransitionErr, if set, is what Transition returns instead of recording —
	// the "that status is not reachable from here" case its one caller treats
	// as best-effort.
	TransitionErr error
}

// TransitionCall is one recorded Transition call.
type TransitionCall struct {
	Key    string
	Status string
}

// Transition records the call (or fails with the programmed error).
func (f *Fake) Transition(_ context.Context, key, status string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.TransitionErr != nil {
		return f.TransitionErr
	}
	f.Transitions = append(f.Transitions, TransitionCall{Key: key, Status: status})
	return nil
}

// PostedComment is one recorded AddComment call.
type PostedComment struct {
	Key string
	ADF json.RawMessage
}

// SetUsers programs Users to return list for every query.
func (f *Fake) SetUsers(list []User) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users = list
}

// AddComment records the call and returns a synthetic comment id.
func (f *Fake) AddComment(_ context.Context, key string, adf json.RawMessage) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.PostErr != nil {
		return "", f.PostErr
	}
	f.Posted = append(f.Posted, PostedComment{Key: key, ADF: adf})
	return fmt.Sprintf("fake-%d", len(f.Posted)), nil
}

// Users returns the programmed user list, bounded by limit.
func (f *Fake) Users(_ context.Context, _ string, limit int) ([]User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if limit > 0 && len(f.users) > limit {
		return append([]User(nil), f.users[:limit]...), nil
	}
	return append([]User(nil), f.users...), nil
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

// IssuesByKey answers from the same programmed issues SetIssue fills, so a
// test never has to program a second, key-set-shaped search: an unprogrammed
// key is simply absent from the result, exactly as a real Jira search would
// leave out an issue that does not exist.
func (f *Fake) IssuesByKey(_ context.Context, keys []string) ([]Issue, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Issue
	for _, k := range keys {
		f.Calls = append(f.Calls, k)
		if is, ok := f.issues[k]; ok {
			out = append(out, is)
		}
	}
	return out, nil
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

// SetSearch programs Search to return issues for exactly this JQL.
func (f *Fake) SetSearch(jql string, issues []Issue) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.search == nil {
		f.search = map[string][]Issue{}
	}
	f.search[jql] = issues
}

// Search returns the programmed issues for jql (nil if none were set).
func (f *Fake) Search(_ context.Context, jql string, limit int) ([]Issue, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.SearchCalls = append(f.SearchCalls, jql)
	list := f.search[jql]
	if limit > 0 && limit < len(list) {
		return append([]Issue(nil), list[:limit]...), nil
	}
	return append([]Issue(nil), list...), nil
}

// SetSprints programs IssueSprints to return these sprints for one key.
func (f *Fake) SetSprints(key string, sprints []Sprint) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sprints == nil {
		f.sprints = map[string][]Sprint{}
	}
	f.sprints[key] = sprints
}

// IssueSprints returns the programmed sprints for key (none if unprogrammed,
// which reads as "this issue is in no sprint" — never an error).
func (f *Fake) IssueSprints(_ context.Context, key string) ([]Sprint, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Sprint(nil), f.sprints[key]...), nil
}
