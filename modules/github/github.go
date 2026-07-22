// Package github is the GitHub-communication module: the one place that talks to
// GitHub (via the `gh` CLI). It is driven by workflow activities — per the
// project rule, only workflows mutate state, and a module like this runs on
// their behalf. It exposes posting a line comment, replying, and fetching
// replies/reactions on a thread.
package github

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

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
}

// Reply is one reply/reaction on a review-comment thread.
type Reply struct {
	ID     int64  `json:"id"`
	Author string `json:"author"`
	Body   string `json:"body"`
	Done   bool   `json:"done"` // reviewer resolved the thread (body contains /resolve)
}

// ReviewComment is a top-level (thread-root) review comment on the diff of a PR:
// one anchored to a file line, made on GitHub (possibly outside this app). Its
// replies are fetched separately via FetchReplies once it is imported as a live
// thread.
type ReviewComment struct {
	ID        int64  `json:"id"`
	Author    string `json:"author"`
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
	ID        int64  `json:"id"`
	Author    string `json:"author"`
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
	// ResolveReviewThread resolves ("Resolve conversation") the review-diff
	// thread whose root comment has REST id commentID. It is a no-op if no such
	// thread is found. GitHub only supports resolving review-diff threads, not
	// PR-wide issue comments.
	ResolveReviewThread(ctx context.Context, pr int, commentID int64) error
	// MarkFileViewed sets (viewed=true) or clears (viewed=false) the "Viewed"
	// checkbox for path in the Files-changed tab of pr.
	MarkFileViewed(ctx context.Context, pr int, path string, viewed bool) error
	// SubmitReview submits a PR-level review — event must be "APPROVE" or
	// "REQUEST_CHANGES". body may be empty for an APPROVE (GitHub allows a
	// bodyless approval); whether an empty body is acceptable for
	// REQUEST_CHANGES is enforced by the caller (GitHub itself rejects a
	// bodyless request-changes review), not by this method.
	SubmitReview(ctx context.Context, pr int, event, body string) error
}

// Module is the production Client: it shells out to `gh api` against repo.
type Module struct {
	repo string // owner/name
}

// New returns a Module for the given owner/name repo slug.
func New(repo string) *Module { return &Module{repo: repo} }

type ghComment struct {
	ID           int64                  `json:"id"`
	Body         string                 `json:"body"`
	User         struct{ Login string } `json:"user"`
	InReplyTo    int64                  `json:"in_reply_to_id"`
	Path         string                 `json:"path"`
	Line         int                    `json:"line"`
	OriginalLine int                    `json:"original_line"`
	StartLine    int                    `json:"start_line"`
	Side         string                 `json:"side"`
	CreatedAt    string                 `json:"created_at"`
	HTMLURL      string                 `json:"html_url"`
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
			ID:     c.ID,
			Author: c.User.Login,
			Body:   c.Body,
			Done:   strings.Contains(strings.ToLower(c.Body), "/resolve"),
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
			ID: c.ID, Author: c.User.Login, Body: c.Body,
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
			ID: c.ID, Author: c.User.Login, Body: c.Body,
			CreatedAt: c.CreatedAt, HTMLURL: c.HTMLURL, Kind: "issue",
		})
	}

	var reviews []struct {
		ID          int64                  `json:"id"`
		Body        string                 `json:"body"`
		User        struct{ Login string } `json:"user"`
		SubmittedAt string                 `json:"submitted_at"`
		HTMLURL     string                 `json:"html_url"`
	}
	if err := m.apiPaginate(ctx, fmt.Sprintf("repos/%s/pulls/%d/reviews", m.repo, pr), &reviews); err != nil {
		return nil, err
	}
	for _, r := range reviews {
		if strings.TrimSpace(r.Body) == "" {
			continue // approve/request-changes with no written summary
		}
		out = append(out, GeneralComment{
			ID: r.ID, Author: r.User.Login, Body: r.Body,
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

// PRMeta fetches the PR's title, web URL, body, author, diff-stats and head
// branch (one `gh api` call).
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
	}
	if err := json.Unmarshal(out, &meta); err != nil {
		return Meta{}, err
	}
	return Meta{
		Title: meta.Title, URL: meta.HTMLURL, Body: meta.Body, Author: meta.User.Login,
		Additions: meta.Additions, Deletions: meta.Deletions, ChangedFiles: meta.ChangedFiles,
		HeadRef: meta.Head.Ref,
	}, nil
}

// DeleteComment removes the review comment commentID from pr.
func (m *Module) DeleteComment(ctx context.Context, pr int, commentID int64) error {
	_, err := m.api(ctx, "DELETE",
		fmt.Sprintf("repos/%s/pulls/comments/%d", m.repo, commentID))
	return err
}

// ResolveReviewThread resolves the review thread whose root comment has REST id
// commentID. GitHub's REST API has no such endpoint, so this goes through the
// GraphQL API: first find the review thread's global node ID by matching the
// commentID against each thread's root comment databaseId, then run the
// resolveReviewThread mutation. No-op if the comment/thread cannot be found.
func (m *Module) ResolveReviewThread(ctx context.Context, pr int, commentID int64) error {
	owner, name, ok := strings.Cut(m.repo, "/")
	if !ok {
		return fmt.Errorf("invalid repo slug %q", m.repo)
	}
	threadID, err := m.reviewThreadID(ctx, owner, name, pr, commentID)
	if err != nil {
		return err
	}
	if threadID == "" {
		return nil // no matching thread on GitHub — nothing to resolve
	}
	const mutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql",
		"-f", "query="+mutation,
		"-F", "id="+threadID,
	)
	if out, err := cmd.Output(); err != nil {
		return fmt.Errorf("gh api graphql resolveReviewThread: %w (%s)", err, out)
	}
	return nil
}

// reviewThreadID returns the GraphQL node ID of the review thread whose root
// comment has REST id commentID, or "" if none matches.
func (m *Module) reviewThreadID(ctx context.Context, owner, name string, pr int, commentID int64) (string, error) {
	const query = `query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100){nodes{id comments(first:1){nodes{databaseId}}}}}}}`
	cmd := exec.CommandContext(ctx, "gh", "api", "graphql",
		"-f", "query="+query,
		"-F", "o="+owner,
		"-F", "n="+name,
		"-F", "pr="+strconv.Itoa(pr),
	)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("gh api graphql review threads: %w", err)
	}
	var res struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ReviewThreads struct {
						Nodes []struct {
							ID       string `json:"id"`
							Comments struct {
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
		return "", fmt.Errorf("parse review threads: %w", err)
	}
	for _, t := range res.Data.Repository.PullRequest.ReviewThreads.Nodes {
		for _, c := range t.Comments.Nodes {
			if c.DatabaseID == commentID {
				return t.ID, nil
			}
		}
	}
	return "", nil
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

// prNodeID fetches the GraphQL global node ID of a pull request.
func (m *Module) prNodeID(ctx context.Context, owner, name string, pr int) (string, error) {
	const query = `query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){id}}}`
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

func (m *Module) api(ctx context.Context, method, endpoint string, args ...string) ([]byte, error) {
	full := append([]string{"api", "--method", method, endpoint}, args...)
	cmd := exec.CommandContext(ctx, "gh", full...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh api %s %s: %w", method, endpoint, err)
	}
	return out, nil
}
