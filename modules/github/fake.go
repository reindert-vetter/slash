package github

import (
	"context"
	"strconv"
	"sync"
)

// Fake is an in-memory Client for tests and local (no-gh) runs. It records
// posted comments/replies and returns whatever replies the test enqueues.
type Fake struct {
	mu              sync.Mutex
	nextID          int64
	Posted          []string // review comment/reply bodies posted, in order
	IssuePosted     []string // issue-comment bodies posted (PR-wide replies), in order
	Deleted         []int64  // comment IDs deleted, in order
	ResolvedThreads []int64  // root comment IDs whose thread was resolved, in order
	replies         []Reply
	reviewComments  []ReviewComment
	general         []GeneralComment
	prState         string          // "" reads as "open"
	prMeta          Meta            // returned by PRMeta (SetPRMeta overrides), PR-independent fallback
	prMetas         map[int]Meta    // per-PR override (SetPRMetaFor), checked first
	viewed          map[string]bool // "pr|path" -> viewed

	lastStartLine int
	lastEndLine   int
	lastSide      string

	lastReviewEvent string
	lastReviewBody  string
	reviewSubmitted int

	collaborators    []Collaborator
	currentUser      Collaborator // returned by CurrentUser (SetCurrentUser seeds it)
	currentUserCalls int
	readyPRs         []int      // PRs flipped to ready-for-review, in order
	requestedRevs    [][]string // reviewer login sets requested, in order

	users          map[string]User // seeded by SetUser, returned by UsersByLogin
	userLookups    int             // how often UsersByLogin was called
	userLoginsSeen []string        // every login UsersByLogin was asked for, in order
}

func (f *Fake) PostReviewComment(_ context.Context, pr int, file string, startLine, endLine int, side, body string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.Posted = append(f.Posted, body)
	if side == "" {
		side = "RIGHT"
	}
	if endLine <= 0 {
		endLine = startLine
	}
	f.lastStartLine = startLine
	f.lastEndLine = endLine
	f.lastSide = side
	return f.nextID, nil
}

// LastStartLine, LastEndLine and LastSide report the range/side of the most
// recent PostReviewComment call (tests only).
func (f *Fake) LastStartLine() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastStartLine
}

func (f *Fake) LastEndLine() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastEndLine
}

func (f *Fake) LastSide() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastSide
}

// LastPostedBody returns the body of the most recently posted comment/reply.
func (f *Fake) LastPostedBody() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.Posted) == 0 {
		return ""
	}
	return f.Posted[len(f.Posted)-1]
}

func (f *Fake) Reply(_ context.Context, pr int, inReplyTo int64, body string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.Posted = append(f.Posted, body)
	return f.nextID, nil
}

func (f *Fake) PostIssueComment(_ context.Context, pr int, body string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.IssuePosted = append(f.IssuePosted, body)
	return f.nextID, nil
}

// IssuePostedCount returns how many issue comments (PR-wide replies) were posted.
func (f *Fake) IssuePostedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.IssuePosted)
}

func (f *Fake) FetchReplies(_ context.Context, pr int, rootID int64) ([]Reply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Reply, len(f.replies))
	copy(out, f.replies)
	return out, nil
}

func (f *Fake) FetchReviewComments(_ context.Context, pr int) ([]ReviewComment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]ReviewComment, len(f.reviewComments))
	copy(out, f.reviewComments)
	return out, nil
}

// SetReviewComments makes the next FetchReviewComments calls return cs.
func (f *Fake) SetReviewComments(cs []ReviewComment) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reviewComments = cs
}

func (f *Fake) FetchGeneralComments(_ context.Context, pr int) ([]GeneralComment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]GeneralComment, len(f.general))
	copy(out, f.general)
	return out, nil
}

// SetGeneralComments makes the next FetchGeneralComments calls return cs.
func (f *Fake) SetGeneralComments(cs []GeneralComment) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.general = cs
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
	if m, ok := f.prMetas[pr]; ok {
		return m, nil
	}
	return f.prMeta, nil
}

// SetPRMeta makes the next PRMeta calls report m for every PR that has no
// per-PR override set via SetPRMetaFor.
func (f *Fake) SetPRMeta(m Meta) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prMeta = m
}

// SetPRMetaFor makes PRMeta(pr) report m for exactly that PR, overriding the
// single PR-independent value SetPRMeta sets — for tests that need several
// PRs with distinct metadata at once (e.g. the cleanup workflow, which checks
// mergedAt per candidate PR).
func (f *Fake) SetPRMetaFor(pr int, m Meta) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.prMetas == nil {
		f.prMetas = map[int]Meta{}
	}
	f.prMetas[pr] = m
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

func (f *Fake) ResolveReviewThread(_ context.Context, pr int, commentID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ResolvedThreads = append(f.ResolvedThreads, commentID)
	return nil
}

// ResolvedThreadCount returns how many review threads have been resolved.
func (f *Fake) ResolvedThreadCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.ResolvedThreads)
}

// LastResolvedThread returns the root comment ID of the most recently resolved
// thread (0 if none).
func (f *Fake) LastResolvedThread() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ResolvedThreads) == 0 {
		return 0
	}
	return f.ResolvedThreads[len(f.ResolvedThreads)-1]
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

func (f *Fake) SubmitReview(_ context.Context, pr int, event, body string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastReviewEvent = event
	f.lastReviewBody = body
	f.reviewSubmitted++
	return nil
}

// LastReviewEvent returns the event of the most recently submitted review.
func (f *Fake) LastReviewEvent() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastReviewEvent
}

// LastReviewBody returns the body of the most recently submitted review.
func (f *Fake) LastReviewBody() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastReviewBody
}

// ReviewSubmittedCount returns how many reviews have been submitted.
func (f *Fake) ReviewSubmittedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reviewSubmitted
}

func (f *Fake) ListCollaborators(_ context.Context) ([]Collaborator, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Collaborator(nil), f.collaborators...), nil
}

func (f *Fake) CurrentUser(_ context.Context) (Collaborator, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.currentUserCalls++
	return f.currentUser, nil
}

// SetCurrentUser seeds the authenticated user returned by CurrentUser (empty
// by default, mirroring an offline run where nothing is known).
func (f *Fake) SetCurrentUser(u Collaborator) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.currentUser = u
}

// CurrentUserCalls is how often CurrentUser was called — lets a test prove the
// caller caches the lookup instead of shelling out per request.
func (f *Fake) CurrentUserCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.currentUserCalls
}

// UsersByLogin returns the seeded users for the asked logins; an unseeded login
// is simply absent, mirroring a real lookup of a deleted account or a bot.
func (f *Fake) UsersByLogin(_ context.Context, logins []string) (map[string]User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.userLookups++
	out := map[string]User{}
	for _, l := range logins {
		f.userLoginsSeen = append(f.userLoginsSeen, l)
		if u, ok := f.users[l]; ok {
			out[l] = u
		}
	}
	return out, nil
}

// SetUser seeds one profile returned by UsersByLogin (keyed on u.Login).
func (f *Fake) SetUser(u User) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.users == nil {
		f.users = map[string]User{}
	}
	f.users[u.Login] = u
}

// UserLookups is how often UsersByLogin was called — lets a test prove the
// caller batches and caches instead of shelling out per login.
func (f *Fake) UserLookups() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.userLookups
}

// UserLoginsSeen is every login UsersByLogin was asked to resolve, in order —
// lets a test prove a cached or skipped login is never looked up again.
func (f *Fake) UserLoginsSeen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.userLoginsSeen...)
}

// SetCollaborators seeds the collaborator list returned by ListCollaborators.
func (f *Fake) SetCollaborators(cs []Collaborator) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.collaborators = cs
}

func (f *Fake) MarkReadyForReview(_ context.Context, pr int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readyPRs = append(f.readyPRs, pr)
	return nil
}

func (f *Fake) RequestReviewers(_ context.Context, pr int, logins []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requestedRevs = append(f.requestedRevs, append([]string(nil), logins...))
	return nil
}

// ReadyForReviewCount returns how many PRs were flipped to ready-for-review.
func (f *Fake) ReadyForReviewCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.readyPRs)
}

// LastRequestedReviewers returns the reviewer set of the most recent
// RequestReviewers call (nil if none).
func (f *Fake) LastRequestedReviewers() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requestedRevs) == 0 {
		return nil
	}
	return f.requestedRevs[len(f.requestedRevs)-1]
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
