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
	// UnresolvedThreads mirrors ResolvedThreads for the reopen direction: root
	// comment IDs whose thread was unresolved, in order.
	UnresolvedThreads []int64
	// resolvedOnGithub is the READ direction: root comment IDs whose thread is
	// already resolved on GitHub, as ResolvedReviewThreads reports them.
	// Deliberately separate from ResolvedThreads above (what this app itself
	// resolved during the test) — the import path exists precisely for threads
	// resolved OUTSIDE the app, so a test must be able to seed one without the
	// app having touched it. Seeded via SetResolvedOnGithub.
	resolvedOnGithub  map[int64]bool
	EditedReviews     map[int64]string // review-comment id -> its last edited body
	EditedIssues      map[int64]string // issue-comment id -> its last edited body
	replies           []Reply
	repliesErr        error // set by SetFetchRepliesErr: FetchReplies fails instead of returning replies
	reviewComments    []ReviewComment
	general           []GeneralComment
	repoInaccessible  bool                 // set by SetRepoAccessible(false): RepoAccessible reports false
	repoAccessibleErr error                // RepoAccessible fails outright instead of reporting a bool
	commentGone       bool                 // set by SetCommentGone: CommentExists reports false
	commentExistsErr  error                // CommentExists fails outright instead of reporting a bool
	prState           string               // "" reads as "open"
	prStateErr        error                // set by SetPRStateErr: PRState fails instead of reporting a state
	prMeta            Meta                 // returned by PRMeta (SetPRMeta overrides), PR-independent fallback
	prMetas           map[int]Meta         // per-PR override (SetPRMetaFor), checked first
	prMetaErrs        map[int]error        // per-PR error override (SetPRMetaErr), checked before prMetas
	changesSince      map[int]SinceChanges // per-PR ChangesSince stub (SetChangesSince)
	viewed            map[string]bool      // "pr|path" -> viewed
	markFileViewedErr error                // set by SetMarkFileViewedErr: MarkFileViewed fails instead of recording

	lastStartLine int
	lastEndLine   int
	lastSide      string

	lastReviewEvent string
	lastReviewBody  string
	reviewSubmitted int

	collaborators    []Collaborator
	currentUser      Collaborator // returned by CurrentUser (SetCurrentUser seeds it)
	currentUserCalls int
	readyPRs         []int             // PRs flipped to ready-for-review, in order
	editedPRs        []EditedPR        // EditPullRequest calls, in order
	requestedRevs    [][]string        // reviewer login sets requested, in order
	removedRevs      []removedReviewer // reviewers dropped from a PR, in order

	users          map[string]User // seeded by SetUser, returned by UsersByLogin
	userLookups    int             // how often UsersByLogin was called
	userLoginsSeen []string        // every login UsersByLogin was asked for, in order
	usersErr       error           // set by SetUsersErr: UsersByLogin fails instead of resolving
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
	if f.repliesErr != nil {
		return nil, f.repliesErr
	}
	out := make([]Reply, len(f.replies))
	copy(out, f.replies)
	return out, nil
}

// SetFetchRepliesErr makes every later FetchReplies call return err instead of
// the enqueued replies — used to simulate a 404 (see github.IsNotFound).
func (f *Fake) SetFetchRepliesErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.repliesErr = err
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
	if f.prStateErr != nil {
		return "", f.prStateErr
	}
	if f.prState == "" {
		return "open", nil
	}
	return f.prState, nil
}

// SetPRStateErr makes every later PRState call fail with err instead of
// reporting a state — mirrors SetFetchRepliesErr/SetRepoAccessible's own
// error-injection shape. PR-independent, like prState itself: this Fake has
// no notion of "a specific PR's live state", only "the one PR the current
// test cares about".
func (f *Fake) SetPRStateErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prStateErr = err
}

// RepoAccessible reports repoAccessible (defaults to true — a fresh Fake
// represents a reachable repo, like a real one with valid credentials).
func (f *Fake) RepoAccessible(_ context.Context) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.repoAccessibleErr != nil {
		return false, f.repoAccessibleErr
	}
	return !f.repoInaccessible, nil
}

// SetRepoAccessible makes the next RepoAccessible calls report accessible.
func (f *Fake) SetRepoAccessible(accessible bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.repoInaccessible = !accessible
}

// CommentExists reports commentGone/commentExistsErr — a fresh Fake says every
// comment still exists, which is what a reachable repo with a live comment
// looks like.
func (f *Fake) CommentExists(_ context.Context, commentID int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commentExistsErr != nil {
		return false, f.commentExistsErr
	}
	return !f.commentGone, nil
}

// SetCommentGone makes the next CommentExists calls report the comment as
// deleted on GitHub.
func (f *Fake) SetCommentGone(gone bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commentGone = gone
}

// SetCommentExistsErr makes every later CommentExists call fail with err
// instead of reporting a state — mirrors SetFetchRepliesErr's own
// error-injection shape.
func (f *Fake) SetCommentExistsErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commentExistsErr = err
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
	if err, ok := f.prMetaErrs[pr]; ok {
		return Meta{}, err
	}
	if m, ok := f.prMetas[pr]; ok {
		return m, nil
	}
	return f.prMeta, nil
}

// SetPRMetaErr makes PRMeta(pr) return err instead of a Meta — for simulating
// a definitive "this PR does not exist" (gh's own "HTTP 404" text) or any
// other gh failure, checked before SetPRMetaFor/the PR-independent fallback.
func (f *Fake) SetPRMetaErr(pr int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.prMetaErrs == nil {
		f.prMetaErrs = map[int]error{}
	}
	f.prMetaErrs[pr] = err
}

// ChangesSince reports whatever SetChangesSince stored for pr (an empty
// result by default — "nothing changed since", the state every test that
// doesn't care about this feature wants).
func (f *Fake) ChangesSince(_ context.Context, pr int, _ string) (SinceChanges, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.changesSince[pr], nil
}

// SetChangesSince makes the next ChangesSince call for pr report c.
func (f *Fake) SetChangesSince(pr int, c SinceChanges) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.changesSince == nil {
		f.changesSince = map[int]SinceChanges{}
	}
	f.changesSince[pr] = c
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

// PostedBodies returns a copy of every review comment/reply body posted, in
// order — for a test that asserts the ORDER of a multi-post flow, not just the
// count (e.g. publishing a local thread: root first, then its replies).
func (f *Fake) PostedBodies() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.Posted...)
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

func (f *Fake) EditReviewComment(_ context.Context, commentID int64, body string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.EditedReviews == nil {
		f.EditedReviews = map[int64]string{}
	}
	f.EditedReviews[commentID] = body
	return nil
}

func (f *Fake) EditIssueComment(_ context.Context, commentID int64, body string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.EditedIssues == nil {
		f.EditedIssues = map[int64]string{}
	}
	f.EditedIssues[commentID] = body
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

func (f *Fake) UnresolveReviewThread(_ context.Context, pr int, commentID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.UnresolvedThreads = append(f.UnresolvedThreads, commentID)
	return nil
}

// SetResolvedOnGithub seeds the threads ResolvedReviewThreads reports as
// resolved — "somebody hit Resolve conversation on github.com", which is what
// the comment import has to pick up.
func (f *Fake) SetResolvedOnGithub(rootIDs ...int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resolvedOnGithub == nil {
		f.resolvedOnGithub = map[int64]bool{}
	}
	for _, id := range rootIDs {
		f.resolvedOnGithub[id] = true
	}
}

func (f *Fake) ResolvedReviewThreads(_ context.Context, pr int) (map[int64]bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[int64]bool{}
	for id := range f.resolvedOnGithub {
		out[id] = true
	}
	return out, nil
}

// UnresolvedThreadCount returns how many review threads have been unresolved.
func (f *Fake) UnresolvedThreadCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.UnresolvedThreads)
}

// LastUnresolvedThread returns the root comment ID of the most recently
// unresolved thread (0 if none).
func (f *Fake) LastUnresolvedThread() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.UnresolvedThreads) == 0 {
		return 0
	}
	return f.UnresolvedThreads[len(f.UnresolvedThreads)-1]
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
	if f.markFileViewedErr != nil {
		return f.markFileViewedErr
	}
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
	if f.usersErr != nil {
		for _, l := range logins {
			f.userLoginsSeen = append(f.userLoginsSeen, l)
		}
		return nil, f.usersErr
	}
	out := map[string]User{}
	for _, l := range logins {
		f.userLoginsSeen = append(f.userLoginsSeen, l)
		if u, ok := f.users[l]; ok {
			out[l] = u
		}
	}
	return out, nil
}

// SetUsersErr makes UsersByLogin fail with err (nil clears it) — for
// simulating a killed/cancelled `gh` call, which must NOT be cached as
// "these logins don't exist" (see DisplayNames in usernames.go).
func (f *Fake) SetUsersErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.usersErr = err
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

// EditPullRequest records the edit and makes every later PRMeta(pr) return
// the new title/body, like GitHub itself would.
func (f *Fake) EditPullRequest(_ context.Context, pr int, title, body string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.editedPRs = append(f.editedPRs, EditedPR{PR: pr, Title: title, Body: body})
	if f.prMetas == nil {
		f.prMetas = map[int]Meta{}
	}
	m, ok := f.prMetas[pr]
	if !ok {
		m = f.prMeta
	}
	m.Title, m.Body = title, body
	f.prMetas[pr] = m
	return nil
}

// EditedPR is one EditPullRequest call the Fake recorded.
type EditedPR struct {
	PR          int
	Title, Body string
}

// EditedPRs returns every EditPullRequest call, in order.
func (f *Fake) EditedPRs() []EditedPR {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]EditedPR(nil), f.editedPRs...)
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

func (f *Fake) RemoveReviewer(_ context.Context, pr int, login string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removedRevs = append(f.removedRevs, removedReviewer{PR: pr, Login: login})
	return nil
}

// removedReviewer is one recorded RemoveReviewer call (see LastRemovedReviewer).
type removedReviewer struct {
	PR    int
	Login string
}

// LastRemovedReviewer returns the PR + login of the most recent RemoveReviewer
// call, and false when there was none.
func (f *Fake) LastRemovedReviewer() (int, string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.removedRevs) == 0 {
		return 0, "", false
	}
	last := f.removedRevs[len(f.removedRevs)-1]
	return last.PR, last.Login, true
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

// SetMarkFileViewedErr makes every later MarkFileViewed call fail with err
// instead of recording the viewed state — mirrors SetFetchRepliesErr's own
// error-injection shape. Used to simulate GitHub rejecting a mark-viewed call
// for a file that is no longer part of the PR ("Filepath must be part of pull
// request").
func (f *Fake) SetMarkFileViewedErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markFileViewedErr = err
}
