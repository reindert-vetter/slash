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
	FetchReplies(ctx context.Context, pr int, rootID int64) ([]Reply, error)
	// PRState reports the lifecycle state of a PR: "open", "merged", or "closed".
	PRState(ctx context.Context, pr int) (string, error)
	// PRMeta fetches the PR's title and web URL.
	PRMeta(ctx context.Context, pr int) (Meta, error)
	// DeleteComment removes a review comment (the root of a thread) from the PR.
	DeleteComment(ctx context.Context, pr int, commentID int64) error
	// MarkFileViewed sets (viewed=true) or clears (viewed=false) the "Viewed"
	// checkbox for path in the Files-changed tab of pr.
	MarkFileViewed(ctx context.Context, pr int, path string, viewed bool) error
}

// Module is the production Client: it shells out to `gh api` against repo.
type Module struct {
	repo string // owner/name
}

// New returns a Module for the given owner/name repo slug.
func New(repo string) *Module { return &Module{repo: repo} }

type ghComment struct {
	ID        int64                  `json:"id"`
	Body      string                 `json:"body"`
	User      struct{ Login string } `json:"user"`
	InReplyTo int64                  `json:"in_reply_to_id"`
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

func (m *Module) api(ctx context.Context, method, endpoint string, args ...string) ([]byte, error) {
	full := append([]string{"api", "--method", method, endpoint}, args...)
	cmd := exec.CommandContext(ctx, "gh", full...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh api %s %s: %w", method, endpoint, err)
	}
	return out, nil
}
