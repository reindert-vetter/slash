// Package github is the GitHub-communication module: the one place that talks to
// GitHub (via the `gh` CLI). It is driven by workflow activities — per the
// project rule, only workflows mutate state, and a module like this runs on
// their behalf. It exposes posting a line comment, replying, and fetching
// replies/reactions on a thread.
package github

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// cliTimeout bounds a single `gh` invocation, applied by this module itself
// so a hung gh can never block a workflow run indefinitely — see the doc
// comment on modules/jira's cliTimeout for the full rationale (inline/blocking
// SignalWorkflow, "shorter deadline always wins", var-not-const for
// testability). Same 20s value: a `gh api`/`gh api graphql` call is a single,
// lightweight round trip, same class of call as acli's.
//
// apiPaginate below applies this PER PAGE (each api() call gets its own fresh
// deadline), not once over the whole paginated fetch — deliberately: each `gh`
// call is its own round trip and should be judged on its own, not penalized by
// however many pages came before it. The trade-off, accepted here: a
// pathologically long result set (many slow pages in a row) can still take a
// while in total, just never hang on any single page.
var cliTimeout = 20 * time.Second

// Meta is PR metadata fetched by the pr_status tracker's basics stage and
// stored in the prmeta read-model.
type Meta struct {
	Title        string `json:"title"`
	URL          string `json:"url"`
	Body         string `json:"body"`
	Author       string `json:"author"`
	Additions    int    `json:"additions"`
	Deletions    int    `json:"deletions"`
	ChangedFiles int    `json:"changedFiles"`
	HeadRef      string `json:"headRef"`
	// MergedAt is the RFC3339 merge timestamp, empty when the PR isn't merged
	// (open, or closed without merging). Used by the cleanup workflow to
	// decide whether a PR's data is old enough to purge.
	MergedAt string `json:"mergedAt"`
}

// Reply is one reply/reaction on a review-comment thread.
type Reply struct {
	ID     int64  `json:"id"`
	Author string `json:"author"`
	// AvatarURL is the author's GitHub profile picture (user.avatar_url). Taken
	// from the API rather than derived from the login, because a GitHub App bot
	// ("kilo-code-bot[bot]") has no github.com/<login>.png shorthand.
	AvatarURL string `json:"avatarUrl"`
	Body      string `json:"body"`
	// Done says the reviewer resolved the thread: the body contains "/resolve".
	// A substring match, so the app's own unresolve trace is deliberately named
	// "/reopen" and not "/unresolve" — the latter would match here and be read
	// back as a resolve (see resolveSentinel/reopenSentinel in workflows.go).
	Done bool `json:"done"`
}

// ReviewComment is a top-level (thread-root) review comment on the diff of a PR:
// one anchored to a file line, made on GitHub (possibly outside this app). Its
// replies are fetched separately via FetchReplies once it is imported as a live
// thread.
type ReviewComment struct {
	ID     int64  `json:"id"`
	Author string `json:"author"`
	// AvatarURL is the author's GitHub profile picture (see Reply.AvatarURL).
	AvatarURL string `json:"avatarUrl"`
	Body      string `json:"body"`
	Path      string `json:"path"`      // file the comment anchors to
	Line      int    `json:"line"`      // line on Side (falls back to original_line)
	StartLine int    `json:"startLine"` // 0 for a single-line comment
	Side      string `json:"side"`      // "RIGHT" (new) | "LEFT" (old)
	CreatedAt string `json:"createdAt"`
	HTMLURL   string `json:"htmlUrl"`
}

// GeneralComment is a PR-wide comment with no file:line anchor: either an issue
// comment (the PR conversation) or a review summary (the body of a submitted
// review). Kind distinguishes the two.
type GeneralComment struct {
	ID     int64  `json:"id"`
	Author string `json:"author"`
	// AvatarURL is the author's GitHub profile picture (see Reply.AvatarURL).
	AvatarURL string `json:"avatarUrl"`
	Body      string `json:"body"`
	CreatedAt string `json:"createdAt"`
	HTMLURL   string `json:"htmlUrl"`
	Kind      string `json:"kind"` // "issue" | "review_summary"
}

// Client is the module's behaviour, so callers (workflows, tests) can depend on
// an interface and swap in Fake.
type Client interface {
	// PostReviewComment posts a review comment on file, anchored to the PR head
	// SHA, and returns the new comment ID. side is "RIGHT" or "LEFT" (empty
	// defaults to "RIGHT"). When startLine is > 0 and < endLine, it posts a
	// multi-line range (start_line..line); otherwise it posts a single line at
	// endLine (falling back to startLine if endLine is <= 0).
	PostReviewComment(ctx context.Context, pr int, file string, startLine, endLine int, side, body string) (int64, error)
	Reply(ctx context.Context, pr int, inReplyTo int64, body string) (int64, error)
	// PostIssueComment posts a new comment to the PR's flat conversation (the
	// issues/{pr}/comments endpoint) and returns its ID. This is how a "reply" to
	// a PR-wide comment (an issue comment / review summary — which have no reply
	// thread on GitHub) is mirrored: as a new conversation entry.
	PostIssueComment(ctx context.Context, pr int, body string) (int64, error)
	FetchReplies(ctx context.Context, pr int, rootID int64) ([]Reply, error)
	// FetchReviewComments returns the thread-root review comments of pr (those
	// not in reply to another comment) — the existing comments on the diff,
	// including ones made outside this app, so they can be imported as live
	// threads.
	FetchReviewComments(ctx context.Context, pr int) ([]ReviewComment, error)
	// FetchGeneralComments returns the PR-wide comments with no file:line
	// anchor: the issue-conversation comments and the non-empty bodies of
	// submitted reviews (review summaries).
	FetchGeneralComments(ctx context.Context, pr int) ([]GeneralComment, error)
	// PRState reports the lifecycle state of a PR: "open", "merged", or "closed".
	PRState(ctx context.Context, pr int) (string, error)
	// PRMeta fetches the PR's title and web URL.
	PRMeta(ctx context.Context, pr int) (Meta, error)
	// DeleteComment removes a review comment (the root of a thread) from the PR.
	DeleteComment(ctx context.Context, pr int, commentID int64) error
	// EditReviewComment overwrites the body of an existing review comment (a
	// thread's root comment, or one of its replies — GitHub represents a
	// review-comment reply as a review comment too, at the same endpoint).
	EditReviewComment(ctx context.Context, commentID int64, body string) error
	// EditIssueComment overwrites the body of an existing issue comment (a
	// PR-wide thread's root, or one of its replies — both mirror as plain issue
	// comments on the PR's flat conversation, see PostIssueComment).
	EditIssueComment(ctx context.Context, commentID int64, body string) error
	// ResolveReviewThread resolves ("Resolve conversation") the review-diff
	// thread whose root comment has REST id commentID. It is a no-op if no such
	// thread is found. GitHub only supports resolving review-diff threads, not
	// PR-wide issue comments.
	ResolveReviewThread(ctx context.Context, pr int, commentID int64) error
	// UnresolveReviewThread reopens ("Unresolve conversation") the review-diff
	// thread whose root comment has REST id commentID — the mirror image of
	// ResolveReviewThread, with the same no-op-if-not-found behaviour.
	UnresolveReviewThread(ctx context.Context, pr int, commentID int64) error
	// ResolvedReviewThreads returns the REST ids of the ROOT comments of every
	// review-diff thread currently marked resolved ("Resolve conversation") on
	// pr. It is the read direction of Resolve/UnresolveReviewThread and the
	// only way to learn that state: it lives on the GraphQL reviewThread node
	// (isResolved), never on the REST comment FetchReviewComments returns.
	ResolvedReviewThreads(ctx context.Context, pr int) (map[int64]bool, error)
	// MarkFileViewed sets (viewed=true) or clears (viewed=false) the "Viewed"
	// checkbox for path in the Files-changed tab of pr.
	MarkFileViewed(ctx context.Context, pr int, path string, viewed bool) error
	// SubmitReview submits a PR-level review — event must be "APPROVE" or
	// "REQUEST_CHANGES". body may be empty for an APPROVE (GitHub allows a
	// bodyless approval); whether an empty body is acceptable for
	// REQUEST_CHANGES is enforced by the caller (GitHub itself rejects a
	// bodyless request-changes review), not by this method.
	SubmitReview(ctx context.Context, pr int, event, body string) error
	// ListCollaborators returns the repo's collaborators (candidate reviewers).
	ListCollaborators(ctx context.Context) ([]Collaborator, error)
	// MarkReadyForReview flips a draft PR to "ready for review".
	MarkReadyForReview(ctx context.Context, pr int) error
	// RequestReviewers requests the given user logins as reviewers on pr.
	RequestReviewers(ctx context.Context, pr int, logins []string) error
	// RemoveReviewer drops one requested reviewer from pr. Removing someone who
	// is not (or no longer) a requested reviewer is a no-op on GitHub's side,
	// never an error worth surfacing.
	RemoveReviewer(ctx context.Context, pr int, login string) error
	// CurrentUser returns the authenticated GitHub user (the local reviewer):
	// their login and profile picture. Used to show "who am I" on the comments
	// and replies written in this app, which carry no GitHub author of their own.
	CurrentUser(ctx context.Context) (Collaborator, error)
	// UsersByLogin resolves a batch of user logins to their GitHub profile name
	// + avatar, keyed by login. A login that no longer exists, or that isn't a
	// User at all (a bot, a team), is simply absent from the result — never an
	// error, since one bad login must not sink the whole batch.
	UsersByLogin(ctx context.Context, logins []string) (map[string]User, error)
	// ChangesSince reports which of pr's commits landed AFTER the RFC3339
	// moment `since`, plus the files those commits touched — the raw material
	// for the review tree's "wat is er veranderd sinds jouw laatste review"
	// block. Nothing new (or an unusable `since`) is an empty result, never an
	// error.
	ChangesSince(ctx context.Context, pr int, since string) (SinceChanges, error)
}

// SinceCommit is one commit of a PR as ChangesSince reports it.
type SinceCommit struct {
	SHA      string `json:"sha"`
	Headline string `json:"headline"` // first line of the commit message
	Date     string `json:"date"`     // RFC3339 committer date
	Author   string `json:"author"`   // login, empty for a commit with no GitHub account
}

// SinceChanges is what happened on a PR after a given moment: the commits that
// landed since (oldest first) and the files they touched. Files is empty when
// the moment predates every commit — the caller then already knows the answer
// ("everything in this PR") from the PR's own changed-file list, so there is no
// point paying for a second API call to rediscover it.
type SinceChanges struct {
	Commits []SinceCommit `json:"commits"`
	Files   []string      `json:"files"`
}

// Collaborator is one repo collaborator — a candidate reviewer.
type Collaborator struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

// User is a GitHub user's public profile as far as the UI needs it: the login
// it was looked up by, the profile `name` (the real name — often "Firstname
// Lastname", but freely editable and frequently EMPTY, so never assume it's
// set) and the avatar.
type User struct {
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl"`
}

// Module is the production Client: it shells out to `gh api` against repo.
type Module struct {
	repo string // owner/name
}

// New returns a Module for the given owner/name repo slug.
func New(repo string) *Module { return &Module{repo: repo} }

// ghUser is the author sub-object every comment/review payload carries. Only
// the login and the avatar URL are used; the avatar comes straight from the
// API so bot accounts (whose login contains "[bot]") get a picture too.
type ghUser struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

type ghComment struct {
	ID           int64  `json:"id"`
	Body         string `json:"body"`
	User         ghUser `json:"user"`
	InReplyTo    int64  `json:"in_reply_to_id"`
	Path         string `json:"path"`
	Line         int    `json:"line"`
	OriginalLine int    `json:"original_line"`
	StartLine    int    `json:"start_line"`
	Side         string `json:"side"`
	CreatedAt    string `json:"created_at"`
	HTMLURL      string `json:"html_url"`
}

// PostReviewComment posts a review comment on file (anchored to the PR head
// SHA) and returns the new comment ID. See the Client interface doc for the
// single-line vs multi-line-range rules.
func (m *Module) PostReviewComment(ctx context.Context, pr int, file string, startLine, endLine int, side, body string) (int64, error) {
	sha, err := m.headSHA(ctx, pr)
	if err != nil {
		return 0, err
	}
	if side == "" {
		side = "RIGHT"
	}
	if endLine <= 0 {
		endLine = startLine
	}
	args := []string{
		"-f", "body=" + body,
		"-f", "commit_id=" + sha,
		"-f", "path=" + file,
		"-F", "line=" + strconv.Itoa(endLine),
		"-f", "side=" + side,
	}
	if startLine > 0 && startLine < endLine {
		args = append(args,
			"-F", "start_line="+strconv.Itoa(startLine),
			"-f", "start_side="+side,
		)
	}
	out, err := m.api(ctx, "POST",
		fmt.Sprintf("repos/%s/pulls/%d/comments", m.repo, pr),
		args...,
	)
	if err != nil {
		return 0, err
	}
	var c ghComment
	if err := json.Unmarshal(out, &c); err != nil {
		return 0, err
	}
	return c.ID, nil
}

// Reply posts a reply into the thread rooted at inReplyTo.
func (m *Module) Reply(ctx context.Context, pr int, inReplyTo int64, body string) (int64, error) {
	out, err := m.api(ctx, "POST",
		fmt.Sprintf("repos/%s/pulls/%d/comments/%d/replies", m.repo, pr, inReplyTo),
		"-f", "body="+body,
	)
	if err != nil {
		return 0, err
	}
	var c ghComment
	if err := json.Unmarshal(out, &c); err != nil {
		return 0, err
	}
	return c.ID, nil
}

// PostIssueComment posts a new comment to the PR's flat conversation
// (issues/{pr}/comments) and returns its ID. See the Client interface doc.
func (m *Module) PostIssueComment(ctx context.Context, pr int, body string) (int64, error) {
	out, err := m.api(ctx, "POST",
		fmt.Sprintf("repos/%s/issues/%d/comments", m.repo, pr),
		"-f", "body="+body,
	)
	if err != nil {
		return 0, err
	}
	var c ghComment
	if err := json.Unmarshal(out, &c); err != nil {
		return 0, err
	}
	return c.ID, nil
}

// FetchReplies returns every reply on the thread rooted at rootID.
func (m *Module) FetchReplies(ctx context.Context, pr int, rootID int64) ([]Reply, error) {
	out, err := m.api(ctx, "GET",
		fmt.Sprintf("repos/%s/pulls/%d/comments?per_page=100", m.repo, pr))
	if err != nil {
		return nil, err
	}
	var comments []ghComment
	if err := json.Unmarshal(out, &comments); err != nil {
		return nil, err
	}
	var replies []Reply
	for _, c := range comments {
		if c.InReplyTo != rootID {
			continue
		}
		replies = append(replies, Reply{
			ID:        c.ID,
			Author:    c.User.Login,
			AvatarURL: c.User.AvatarURL,
			Body:      c.Body,
			Done:      strings.Contains(strings.ToLower(c.Body), "/resolve"),
		})
	}
	return replies, nil
}

// FetchReviewComments returns the thread-root review comments of pr (in_reply_to
// == 0). See the Client interface doc.
func (m *Module) FetchReviewComments(ctx context.Context, pr int) ([]ReviewComment, error) {
	var all []ghComment
	if err := m.apiPaginate(ctx, fmt.Sprintf("repos/%s/pulls/%d/comments", m.repo, pr), &all); err != nil {
		return nil, err
	}
	var out []ReviewComment
	for _, c := range all {
		if c.InReplyTo != 0 {
			continue // a reply — imported via FetchReplies once the root is live
		}
		line := c.Line
		if line == 0 {
			line = c.OriginalLine // outdated comment: fall back to the original line
		}
		side := c.Side
		if side == "" {
			side = "RIGHT"
		}
		out = append(out, ReviewComment{
			ID: c.ID, Author: c.User.Login, AvatarURL: c.User.AvatarURL, Body: c.Body,
			Path: c.Path, Line: line, StartLine: c.StartLine, Side: side,
			CreatedAt: c.CreatedAt, HTMLURL: c.HTMLURL,
		})
	}
	return out, nil
}

// FetchGeneralComments returns the PR-wide comments (issue comments + review
// summaries). See the Client interface doc.
func (m *Module) FetchGeneralComments(ctx context.Context, pr int) ([]GeneralComment, error) {
	var out []GeneralComment

	var issues []ghComment
	if err := m.apiPaginate(ctx, fmt.Sprintf("repos/%s/issues/%d/comments", m.repo, pr), &issues); err != nil {
		return nil, err
	}
	for _, c := range issues {
		out = append(out, GeneralComment{
			ID: c.ID, Author: c.User.Login, AvatarURL: c.User.AvatarURL, Body: c.Body,
			CreatedAt: c.CreatedAt, HTMLURL: c.HTMLURL, Kind: "issue",
		})
	}

	var reviews []struct {
		ID          int64  `json:"id"`
		Body        string `json:"body"`
		User        ghUser `json:"user"`
		SubmittedAt string `json:"submitted_at"`
		HTMLURL     string `json:"html_url"`
	}
	if err := m.apiPaginate(ctx, fmt.Sprintf("repos/%s/pulls/%d/reviews", m.repo, pr), &reviews); err != nil {
		return nil, err
	}
	for _, r := range reviews {
		if strings.TrimSpace(r.Body) == "" {
			continue // approve/request-changes with no written summary
		}
		out = append(out, GeneralComment{
			ID: r.ID, Author: r.User.Login, AvatarURL: r.User.AvatarURL, Body: r.Body,
			CreatedAt: r.SubmittedAt, HTMLURL: r.HTMLURL, Kind: "review_summary",
		})
	}
	return out, nil
}

func (m *Module) headSHA(ctx context.Context, pr int) (string, error) {
	out, err := m.api(ctx, "GET",
		fmt.Sprintf("repos/%s/pulls/%d", m.repo, pr))
	if err != nil {
		return "", err
	}
	var meta struct {
		Head struct{ Sha string } `json:"head"`
	}
	if err := json.Unmarshal(out, &meta); err != nil {
		return "", err
	}
	return meta.Head.Sha, nil
}

// PRState reports whether a PR is "open", "merged", or "closed" (a merged PR
// reports "merged", not "closed").
func (m *Module) PRState(ctx context.Context, pr int) (string, error) {
	out, err := m.api(ctx, "GET",
		fmt.Sprintf("repos/%s/pulls/%d", m.repo, pr))
	if err != nil {
		return "", err
	}
	var meta struct {
		State  string `json:"state"` // "open" | "closed"
		Merged bool   `json:"merged"`
	}
	if err := json.Unmarshal(out, &meta); err != nil {
		return "", err
	}
	if meta.Merged {
		return "merged", nil
	}
	return meta.State, nil
}

// PRMeta fetches the PR's title, web URL, body, author, diff-stats, head
// branch, and merge timestamp (one `gh api` call).
func (m *Module) PRMeta(ctx context.Context, pr int) (Meta, error) {
	out, err := m.api(ctx, "GET",
		fmt.Sprintf("repos/%s/pulls/%d", m.repo, pr))
	if err != nil {
		return Meta{}, err
	}
	var meta struct {
		Title        string                 `json:"title"`
		HTMLURL      string                 `json:"html_url"`
		Body         string                 `json:"body"`
		User         struct{ Login string } `json:"user"`
		Additions    int                    `json:"additions"`
		Deletions    int                    `json:"deletions"`
		ChangedFiles int                    `json:"changed_files"`
		Head         struct{ Ref string }   `json:"head"`
		MergedAt     *string                `json:"merged_at"` // null when not merged
	}
	if err := json.Unmarshal(out, &meta); err != nil {
		return Meta{}, err
	}
	mergedAt := ""
	if meta.MergedAt != nil {
		mergedAt = *meta.MergedAt
	}
	return Meta{
		Title: meta.Title, URL: meta.HTMLURL, Body: meta.Body, Author: meta.User.Login,
		Additions: meta.Additions, Deletions: meta.Deletions, ChangedFiles: meta.ChangedFiles,
		HeadRef: meta.Head.Ref, MergedAt: mergedAt,
	}, nil
}

// ChangesSince lists the commits of pr that landed after `since` (RFC3339) and
// the files they touched, in at most two `gh api` calls:
//
//  1. the PR's commit list, to split "already seen at `since`" from "new";
//  2. a compare of the last-seen commit against the newest one, for the file
//     list (skipped when there is no last-seen commit — see SinceChanges.Files,
//     or when nothing is new at all).
//
// Best-effort by design: an empty/unparsable `since`, a PR with no commits, or
// nothing new since that moment all return an empty result and no error — the
// caller renders nothing in that case, it is not a failure.
func (m *Module) ChangesSince(ctx context.Context, pr int, since string) (SinceChanges, error) {
	sinceT, err := time.Parse(time.RFC3339, since)
	if err != nil {
		return SinceChanges{}, nil
	}
	out, err := m.api(ctx, "GET", fmt.Sprintf("repos/%s/pulls/%d/commits?per_page=100", m.repo, pr))
	if err != nil {
		return SinceChanges{}, err
	}
	var raw []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message   string `json:"message"`
			Committer struct {
				Date string `json:"date"`
			} `json:"committer"`
		} `json:"commit"`
		Author *ghUser `json:"author"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return SinceChanges{}, err
	}
	var res SinceChanges
	lastSeen := ""
	for _, c := range raw {
		t, err := time.Parse(time.RFC3339, c.Commit.Committer.Date)
		if err != nil {
			continue
		}
		if !t.After(sinceT) {
			lastSeen = c.SHA
			continue
		}
		author := ""
		if c.Author != nil {
			author = c.Author.Login
		}
		res.Commits = append(res.Commits, SinceCommit{
			SHA:      c.SHA,
			Headline: strings.TrimSpace(strings.SplitN(c.Commit.Message, "\n", 2)[0]),
			Date:     c.Commit.Committer.Date,
			Author:   author,
		})
	}
	if len(res.Commits) == 0 || lastSeen == "" {
		return res, nil
	}
	newest := res.Commits[len(res.Commits)-1].SHA
	out, err = m.api(ctx, "GET", fmt.Sprintf("repos/%s/compare/%s...%s", m.repo, lastSeen, newest))
	if err != nil {
		return res, nil // the commit list alone is still useful
	}
	var cmp struct {
		Files []struct {
			Filename string `json:"filename"`
		} `json:"files"`
	}
	if err := json.Unmarshal(out, &cmp); err != nil {
		return res, nil
	}
	for _, f := range cmp.Files {
		res.Files = append(res.Files, f.Filename)
	}
	return res, nil
}

// DeleteComment removes the review comment commentID from pr.
func (m *Module) DeleteComment(ctx context.Context, pr int, commentID int64) error {
	_, err := m.api(ctx, "DELETE",
		fmt.Sprintf("repos/%s/pulls/comments/%d", m.repo, commentID))
	return err
}

// EditReviewComment overwrites the body of the existing review comment
// commentID (its root, or one of its replies — both live at this same
// endpoint). See the Client interface doc.
func (m *Module) EditReviewComment(ctx context.Context, commentID int64, body string) error {
	_, err := m.api(ctx, "PATCH",
		fmt.Sprintf("repos/%s/pulls/comments/%d", m.repo, commentID),
		"-f", "body="+body,
	)
	return err
}

// EditIssueComment overwrites the body of the existing issue comment
// commentID. See the Client interface doc.
func (m *Module) EditIssueComment(ctx context.Context, commentID int64, body string) error {
	_, err := m.api(ctx, "PATCH",
		fmt.Sprintf("repos/%s/issues/comments/%d", m.repo, commentID),
		"-f", "body="+body,
	)
	return err
}

// ResolveReviewThread resolves the review thread whose root comment has REST id
// commentID. GitHub's REST API has no such endpoint, so this goes through the
// GraphQL API — see reviewThreadMutation for the shared lookup+mutate path.
// No-op if the comment/thread cannot be found.
func (m *Module) ResolveReviewThread(ctx context.Context, pr int, commentID int64) error {
	const mutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`
	return m.reviewThreadMutation(ctx, pr, commentID, "resolveReviewThread", mutation)
}

// UnresolveReviewThread reopens the review thread whose root comment has REST id
// commentID — the exact mirror of ResolveReviewThread (same thread lookup, the
// unresolveReviewThread mutation instead). No-op if the comment/thread cannot be
// found. See the Client interface doc.
func (m *Module) UnresolveReviewThread(ctx context.Context, pr int, commentID int64) error {
	const mutation = `mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}`
	return m.reviewThreadMutation(ctx, pr, commentID, "unresolveReviewThread", mutation)
}

// reviewThreadMutation is the shared body of ResolveReviewThread and
// UnresolveReviewThread: find the review thread's global node ID by matching
// commentID against each thread's root comment databaseId, then run `mutation`
// against it. `label` only names the mutation in the error message. No-op when
// no thread matches.
func (m *Module) reviewThreadMutation(ctx context.Context, pr int, commentID int64, label, mutation string) error {
	owner, name, ok := strings.Cut(m.repo, "/")
	if !ok {
		return fmt.Errorf("invalid repo slug %q", m.repo)
	}
	threadID, err := m.reviewThreadID(ctx, owner, name, pr, commentID)
	if err != nil {
		return err
	}
	if threadID == "" {
		return nil // no matching thread on GitHub — nothing to do
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout) // see cliTimeout doc
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql",
		"-f", "query="+mutation,
		"-F", "id="+threadID,
	)
	if out, err := cmd.Output(); err != nil {
		return fmt.Errorf("gh api graphql %s: %w (%s)", label, err, out)
	}
	return nil
}

// reviewThread is one GraphQL reviewThread node, reduced to the three things
// this module needs: the node id (to mutate it), the root comment's REST id
// (how the rest of the app addresses a thread) and whether it is resolved.
type reviewThread struct {
	ID         string
	RootID     int64
	IsResolved bool
}

// reviewThreads lists pr's review threads. The single GraphQL round-trip both
// reviewThreadID (the mutate direction) and ResolvedReviewThreads (the read
// direction) build on — `isResolved` rides along for free, and keeping one
// query means the two can't drift apart on pagination or shape.
func (m *Module) reviewThreads(ctx context.Context, owner, name string, pr int) ([]reviewThread, error) {
	const query = `query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}`
	ctx, cancel := context.WithTimeout(ctx, cliTimeout) // see cliTimeout doc
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql",
		"-f", "query="+query,
		"-F", "o="+owner,
		"-F", "n="+name,
		"-F", "pr="+strconv.Itoa(pr),
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh api graphql review threads: %w", err)
	}
	var res struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ReviewThreads struct {
						Nodes []struct {
							ID         string `json:"id"`
							IsResolved bool   `json:"isResolved"`
							Comments   struct {
								Nodes []struct {
									DatabaseID int64 `json:"databaseId"`
								} `json:"nodes"`
							} `json:"comments"`
						} `json:"nodes"`
					} `json:"reviewThreads"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return nil, fmt.Errorf("parse review threads: %w", err)
	}
	threads := make([]reviewThread, 0, len(res.Data.Repository.PullRequest.ReviewThreads.Nodes))
	for _, t := range res.Data.Repository.PullRequest.ReviewThreads.Nodes {
		var root int64
		if len(t.Comments.Nodes) > 0 {
			root = t.Comments.Nodes[0].DatabaseID
		}
		threads = append(threads, reviewThread{ID: t.ID, RootID: root, IsResolved: t.IsResolved})
	}
	return threads, nil
}

// reviewThreadID returns the GraphQL node ID of the review thread whose root
// comment has REST id commentID, or "" if none matches.
func (m *Module) reviewThreadID(ctx context.Context, owner, name string, pr int, commentID int64) (string, error) {
	threads, err := m.reviewThreads(ctx, owner, name, pr)
	if err != nil {
		return "", err
	}
	for _, t := range threads {
		if t.RootID == commentID {
			return t.ID, nil
		}
	}
	return "", nil
}

// ResolvedReviewThreads reports which of pr's review threads are resolved on
// GitHub, keyed by their root comment's REST id. See the Client interface doc.
func (m *Module) ResolvedReviewThreads(ctx context.Context, pr int) (map[int64]bool, error) {
	owner, name, ok := strings.Cut(m.repo, "/")
	if !ok {
		return nil, fmt.Errorf("invalid repo slug %q", m.repo)
	}
	threads, err := m.reviewThreads(ctx, owner, name, pr)
	if err != nil {
		return nil, err
	}
	resolved := map[int64]bool{}
	for _, t := range threads {
		if t.IsResolved && t.RootID != 0 {
			resolved[t.RootID] = true
		}
	}
	return resolved, nil
}

// MarkFileViewed sets or clears the "Viewed" checkbox for path in the PR's
// Files-changed tab. GitHub's REST API has no such endpoint, so this goes
// through the GraphQL API: first resolve the PR's node ID, then run the
// markFileAsViewed/unmarkFileAsViewed mutation against it.
func (m *Module) MarkFileViewed(ctx context.Context, pr int, path string, viewed bool) error {
	owner, name, ok := strings.Cut(m.repo, "/")
	if !ok {
		return fmt.Errorf("invalid repo slug %q", m.repo)
	}
	nodeID, err := m.prNodeID(ctx, owner, name, pr)
	if err != nil {
		return err
	}
	mutation := "unmarkFileAsViewed"
	if viewed {
		mutation = "markFileAsViewed"
	}
	query := fmt.Sprintf(
		"mutation($p:String!,$id:ID!){%s(input:{path:$p, pullRequestId:$id}){clientMutationId}}",
		mutation)
	ctx, cancel := context.WithTimeout(ctx, cliTimeout) // see cliTimeout doc
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql",
		"-f", "query="+query,
		"-F", "p="+path,
		"-F", "id="+nodeID,
	)
	if out, err := cmd.Output(); err != nil {
		return fmt.Errorf("gh api graphql %s: %w (%s)", mutation, err, out)
	}
	return nil
}

// allowedReviewEvents is the set of GitHub review-submission events this app
// supports. Checked before shelling out, per the project rule to validate
// input before it reaches exec.CommandContext.
var allowedReviewEvents = map[string]bool{
	"APPROVE":         true,
	"REQUEST_CHANGES": true,
}

// SubmitReview submits a PR-level review. See the Client interface doc for the
// event/body rules.
func (m *Module) SubmitReview(ctx context.Context, pr int, event, body string) error {
	if !allowedReviewEvents[event] {
		return fmt.Errorf("invalid review event %q", event)
	}
	args := []string{"-f", "event=" + event}
	if body != "" {
		args = append(args, "-f", "body="+body)
	}
	_, err := m.api(ctx, "POST",
		fmt.Sprintf("repos/%s/pulls/%d/reviews", m.repo, pr),
		args...,
	)
	return err
}

// reReviewerLogin restricts a reviewer login to GitHub's allowed username
// charset before it reaches exec.CommandContext (input-validation rule).
var reReviewerLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)

// CurrentUser returns the authenticated user (`gh api user`) — login + avatar.
// See the Client interface doc for why it exists.
func (m *Module) CurrentUser(ctx context.Context) (Collaborator, error) {
	out, err := m.api(ctx, "GET", "user")
	if err != nil {
		return Collaborator{}, err
	}
	var u ghUser
	if err := json.Unmarshal(out, &u); err != nil {
		return Collaborator{}, err
	}
	return Collaborator{Login: u.Login, AvatarURL: u.AvatarURL}, nil
}

// reUserLogin restricts a user login to GitHub's allowed username charset
// before it reaches exec.CommandContext (input-validation rule). Same shape as
// reReviewerLogin; kept separate so neither call site's meaning depends on the
// other's.
var reUserLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)

// UsersByLogin resolves several logins in ONE `gh api graphql` call, via one
// aliased `user(login:)` field per login (u0, u1, …). Logins are passed as -f
// string variables, never interpolated into the query, and each is validated
// against reUserLogin first — an invalid one is skipped rather than shelled out.
//
// A login that doesn't resolve (deleted account, a bot, a team name) comes back
// as a null field PLUS a GraphQL error, which makes `gh` exit non-zero even
// though the other aliases resolved fine. stdout still carries that partial
// data, so we parse it regardless and only surface the error when nothing at
// all could be read.
func (m *Module) UsersByLogin(ctx context.Context, logins []string) (map[string]User, error) {
	out := map[string]User{}
	var decl, fields strings.Builder
	args := []string{"api", "graphql"}
	n := 0
	for _, login := range logins {
		if !reUserLogin.MatchString(login) {
			continue
		}
		fmt.Fprintf(&decl, "$l%d:String!,", n)
		fmt.Fprintf(&fields, "u%d: user(login:$l%d){login name avatarUrl} ", n, n)
		args = append(args, "-f", fmt.Sprintf("l%d=%s", n, login))
		n++
	}
	if n == 0 {
		return out, nil
	}
	query := fmt.Sprintf("query(%s){%s}", strings.TrimSuffix(decl.String(), ","), fields.String())
	args = append(args, "-f", "query="+query)

	ctx, cancel := context.WithTimeout(ctx, cliTimeout) // see cliTimeout doc
	defer cancel()
	raw, execErr := exec.CommandContext(ctx, "gh", args...).Output()
	var res struct {
		Data map[string]*User `json:"data"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		if execErr != nil {
			return nil, fmt.Errorf("gh api graphql users: %w", execErr)
		}
		return nil, fmt.Errorf("parse users: %w", err)
	}
	for _, u := range res.Data {
		if u != nil && u.Login != "" {
			out[u.Login] = *u
		}
	}
	return out, nil
}

// ListCollaborators returns the repo's collaborators as candidate reviewers.
func (m *Module) ListCollaborators(ctx context.Context) ([]Collaborator, error) {
	var raw []struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := m.apiPaginate(ctx, fmt.Sprintf("repos/%s/collaborators", m.repo), &raw); err != nil {
		return nil, err
	}
	out := make([]Collaborator, 0, len(raw))
	for _, c := range raw {
		out = append(out, Collaborator{Login: c.Login, AvatarURL: c.AvatarURL})
	}
	return out, nil
}

// MarkReadyForReview flips a draft PR to "ready for review" via the GraphQL
// markPullRequestReadyForReview mutation.
func (m *Module) MarkReadyForReview(ctx context.Context, pr int) error {
	owner, name, ok := strings.Cut(m.repo, "/")
	if !ok {
		return fmt.Errorf("invalid repo slug %q", m.repo)
	}
	nodeID, err := m.prNodeID(ctx, owner, name, pr)
	if err != nil {
		return err
	}
	const query = "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}"
	ctx, cancel := context.WithTimeout(ctx, cliTimeout) // see cliTimeout doc
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql",
		"-f", "query="+query,
		"-F", "id="+nodeID,
	)
	if out, err := cmd.Output(); err != nil {
		return fmt.Errorf("gh api graphql markPullRequestReadyForReview: %w (%s)", err, out)
	}
	return nil
}

// RequestReviewers requests the given user logins as reviewers on pr. Each
// login is validated against GitHub's username charset before it reaches gh.
func (m *Module) RequestReviewers(ctx context.Context, pr int, logins []string) error {
	if len(logins) == 0 {
		return nil
	}
	args := make([]string, 0, len(logins)*2)
	for _, login := range logins {
		if !reReviewerLogin.MatchString(login) {
			return fmt.Errorf("invalid reviewer login %q", login)
		}
		args = append(args, "-f", "reviewers[]="+login)
	}
	_, err := m.api(ctx, "POST",
		fmt.Sprintf("repos/%s/pulls/%d/requested_reviewers", m.repo, pr),
		args...,
	)
	return err
}

// RemoveReviewer drops one requested reviewer from pr — the mirror image of
// RequestReviewers (same endpoint, DELETE instead of POST). The login is
// validated against GitHub's username charset before it reaches gh, exactly
// like the request path.
func (m *Module) RemoveReviewer(ctx context.Context, pr int, login string) error {
	if !reReviewerLogin.MatchString(login) {
		return fmt.Errorf("invalid reviewer login %q", login)
	}
	_, err := m.api(ctx, "DELETE",
		fmt.Sprintf("repos/%s/pulls/%d/requested_reviewers", m.repo, pr),
		"-f", "reviewers[]="+login,
	)
	return err
}

// prNodeID fetches the GraphQL global node ID of a pull request.
func (m *Module) prNodeID(ctx context.Context, owner, name string, pr int) (string, error) {
	const query = `query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){id}}}`
	ctx, cancel := context.WithTimeout(ctx, cliTimeout) // see cliTimeout doc
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql",
		"-f", "query="+query,
		"-F", "o="+owner,
		"-F", "n="+name,
		"-F", "pr="+strconv.Itoa(pr),
	)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("gh api graphql pr node id: %w", err)
	}
	var res struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ID string `json:"id"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return "", err
	}
	if res.Data.Repository.PullRequest.ID == "" {
		return "", fmt.Errorf("pr node id not found for %s/%s#%d", owner, name, pr)
	}
	return res.Data.Repository.PullRequest.ID, nil
}

// apiPaginate GETs a list endpoint page by page (per_page=100) and unmarshals
// the concatenation of every page into out (a pointer to a slice). It stops on
// the first empty page. Used for the review/issue/review-comment lists, which
// can exceed one page on a busy PR.
func (m *Module) apiPaginate(ctx context.Context, endpoint string, out any) error {
	sep := "?"
	if strings.Contains(endpoint, "?") {
		sep = "&"
	}
	// out must be *[]T; accumulate into a fresh JSON array we re-decode at the end.
	var combined []json.RawMessage
	for page := 1; ; page++ {
		raw, err := m.api(ctx, "GET", fmt.Sprintf("%s%sper_page=100&page=%d", endpoint, sep, page))
		if err != nil {
			return err
		}
		var chunk []json.RawMessage
		if err := json.Unmarshal(raw, &chunk); err != nil {
			return err
		}
		if len(chunk) == 0 {
			break
		}
		combined = append(combined, chunk...)
		if len(chunk) < 100 {
			break // last (partial) page
		}
	}
	merged, err := json.Marshal(combined)
	if err != nil {
		return err
	}
	return json.Unmarshal(merged, out)
}

// api runs one `gh api` call, bounded by cliTimeout. apiPaginate calls this
// once per page, so each page gets its own fresh deadline (see the cliTimeout
// doc comment for why that's deliberate).
func (m *Module) api(ctx context.Context, method, endpoint string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	full := append([]string{"api", "--method", method, endpoint}, args...)
	cmd := exec.CommandContext(ctx, "gh", full...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("gh api %s %s: %w: %s", method, endpoint, err, msg)
		}
		return nil, fmt.Errorf("gh api %s %s: %w", method, endpoint, err)
	}
	return out, nil
}
