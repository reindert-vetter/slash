package github

import (
	"context"
	"sync"
)

// Fake is an in-memory Client for tests and local (no-gh) runs. It records
// posted comments/replies and returns whatever replies the test enqueues.
type Fake struct {
	mu      sync.Mutex
	nextID  int64
	Posted  []string // bodies posted (root + replies), in order
	replies []Reply
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
