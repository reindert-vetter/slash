package github

import (
	"context"
	"strconv"
	"sync"
)

// Fake is an in-memory Client for tests and local (no-gh) runs. It records
// posted comments/replies and returns whatever replies the test enqueues.
type Fake struct {
	mu      sync.Mutex
	nextID  int64
	Posted  []string // bodies posted (root + replies), in order
	Deleted []int64  // comment IDs deleted, in order
	replies []Reply
	prState string          // "" reads as "open"
	prMeta  Meta            // returned by PRMeta (SetPRMeta overrides)
	viewed  map[string]bool // "pr|path" -> viewed
}

func (f *Fake) PostLineComment(_ context.Context, pr int, file string, line int, body string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.Posted = append(f.Posted, body)
	return f.nextID, nil
}

func (f *Fake) Reply(_ context.Context, pr int, inReplyTo int64, body string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.Posted = append(f.Posted, body)
	return f.nextID, nil
}

func (f *Fake) FetchReplies(_ context.Context, pr int, rootID int64) ([]Reply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Reply, len(f.replies))
	copy(out, f.replies)
	return out, nil
}

func (f *Fake) PRState(_ context.Context, pr int) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.prState == "" {
		return "open", nil
	}
	return f.prState, nil
}

// SetPRState makes the next PRState calls report state ("open"|"merged"|"closed").
func (f *Fake) SetPRState(state string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prState = state
}

func (f *Fake) PRMeta(_ context.Context, pr int) (Meta, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.prMeta, nil
}

// SetPRMeta makes the next PRMeta calls report m.
func (f *Fake) SetPRMeta(m Meta) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prMeta = m
}

// EnqueueReply makes r visible to the next FetchReplies (as if it appeared on
// GitHub).
func (f *Fake) EnqueueReply(r Reply) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies = append(f.replies, r)
}

// PostedCount returns how many comments/replies have been posted.
func (f *Fake) PostedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.Posted)
}

func (f *Fake) DeleteComment(_ context.Context, pr int, commentID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Deleted = append(f.Deleted, commentID)
	return nil
}

// DeletedCount returns how many comments have been deleted.
func (f *Fake) DeletedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.Deleted)
}

func viewedKey(pr int, path string) string {
	return strconv.Itoa(pr) + "|" + path
}

func (f *Fake) MarkFileViewed(_ context.Context, pr int, path string, viewed bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.viewed == nil {
		f.viewed = map[string]bool{}
	}
	if viewed {
		f.viewed[viewedKey(pr, path)] = true
	} else {
		delete(f.viewed, viewedKey(pr, path))
	}
	return nil
}

// IsViewed reports whether MarkFileViewed(pr, path, true) is the last call
// recorded for that pr/path (and no later unmark happened).
func (f *Fake) IsViewed(pr int, path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.viewed[viewedKey(pr, path)]
}

// ViewedFiles returns a copy of the current viewed-set (pr|path -> true).
func (f *Fake) ViewedFiles() map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]bool, len(f.viewed))
	for k, v := range f.viewed {
		out[k] = v
	}
	return out
}
