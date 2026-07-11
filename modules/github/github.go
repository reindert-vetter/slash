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
	PostLineComment(ctx context.Context, pr int, file string, line int, body string) (int64, error)
	Reply(ctx context.Context, pr int, inReplyTo int64, body string) (int64, error)
	FetchReplies(ctx context.Context, pr int, rootID int64) ([]Reply, error)
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

// PostLineComment posts a review comment on file:line of a PR (anchored to the
// PR head SHA) and returns the new comment ID.
func (m *Module) PostLineComment(ctx context.Context, pr int, file string, line int, body string) (int64, error) {
	sha, err := m.headSHA(ctx, pr)
	if err != nil {
		return 0, err
	}
	out, err := m.api(ctx, "POST",
		fmt.Sprintf("repos/%s/pulls/%d/comments", m.repo, pr),
		"-f", "body="+body,
		"-f", "commit_id="+sha,
		"-f", "path="+file,
		"-F", "line="+strconv.Itoa(line),
		"-f", "side=RIGHT",
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

func (m *Module) api(ctx context.Context, method, endpoint string, args ...string) ([]byte, error) {
	full := append([]string{"api", "--method", method, endpoint}, args...)
	cmd := exec.CommandContext(ctx, "gh", full...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh api %s %s: %w", method, endpoint, err)
	}
	return out, nil
}
