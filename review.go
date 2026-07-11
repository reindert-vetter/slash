package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"
)

// This file defines the first slash review *task* as a durable tembed workflow:
// post a comment on a line of code, then keep the thread alive — a background
// poller watches GitHub for replies and feeds each one to the workflow as a
// "reply" signal, and the workflow answers with an extra comment. Because it
// runs on tembed, the conversation survives a server restart: the posted
// comment is never re-posted, and the workflow resumes waiting for the next
// reply.

// Workflow + signal names.
const (
	reviewWorkflow = "reviewComment"
	replySignal    = "reply"
)

// ReviewCommentInput starts a review conversation on one line of a PR.
type ReviewCommentInput struct {
	PR   int    `json:"pr"`
	File string `json:"file"`
	Line int    `json:"line"`
	Body string `json:"body"`
}

// ReviewReply is one incoming reply on the comment thread, delivered to the
// workflow as a signal by the poller.
type ReviewReply struct {
	ID     int64  `json:"id"`
	Author string `json:"author"`
	Body   string `json:"body"`
	Done   bool   `json:"done"` // reviewer marked the thread resolved
}

// postResult is what the postLineComment activity returns.
type postResult struct {
	CommentID int64 `json:"commentId"`
}

// replyInput is the input to the replyComment activity.
type replyInput struct {
	PR        int    `json:"pr"`
	InReplyTo int64  `json:"inReplyTo"`
	Body      string `json:"body"`
}

// reviewSummary is the workflow's result.
type reviewSummary struct {
	RootCommentID int64 `json:"rootCommentId"`
	Replies       int   `json:"replies"`
}

// GitHubReviewer is the slice of GitHub that the review task needs. The real
// implementation shells out to `gh`; tests use a fake.
type GitHubReviewer interface {
	// PostLineComment posts a review comment on file:line of a PR and returns
	// the new comment's ID.
	PostLineComment(ctx context.Context, pr int, file string, line int, body string) (int64, error)
	// Reply posts a reply into the thread rooted at inReplyTo.
	Reply(ctx context.Context, pr int, inReplyTo int64, body string) (int64, error)
	// FetchReplies returns every reply on the thread rooted at rootID.
	FetchReplies(ctx context.Context, pr int, rootID int64) ([]ReviewReply, error)
}

// ReviewManager wires the workflow + activities onto a tembed engine and runs
// the GitHub poller that turns replies into signals.
type ReviewManager struct {
	engine   *tembed.Engine
	gh       GitHubReviewer
	interval time.Duration
	logf     func(string, ...any)
}

// NewReviewManager registers the review workflow and its activities on engine.
func NewReviewManager(engine *tembed.Engine, gh GitHubReviewer, pollInterval time.Duration) *ReviewManager {
	m := &ReviewManager{engine: engine, gh: gh, interval: pollInterval, logf: log.Printf}

	engine.RegisterActivity("postLineComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var input ReviewCommentInput
		if err := json.Unmarshal(in, &input); err != nil {
			return nil, err
		}
		id, err := gh.PostLineComment(ctx, input.PR, input.File, input.Line, input.Body)
		if err != nil {
			return nil, err
		}
		return json.Marshal(postResult{CommentID: id})
	})

	engine.RegisterActivity("replyComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var input replyInput
		if err := json.Unmarshal(in, &input); err != nil {
			return nil, err
		}
		id, err := gh.Reply(ctx, input.PR, input.InReplyTo, input.Body)
		if err != nil {
			return nil, err
		}
		return json.Marshal(postResult{CommentID: id})
	})

	engine.RegisterWorkflow(reviewWorkflow, reviewCommentWorkflow)
	return m
}

// reviewCommentWorkflow is the durable definition: post the comment, then loop
// answering each reply until the reviewer resolves the thread.
func reviewCommentWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ReviewCommentInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}

	var posted postResult
	if err := w.ExecuteActivity("postLineComment", in, &posted); err != nil {
		return nil, fmt.Errorf("post line comment: %w", err)
	}

	replies := 0
	for {
		var r ReviewReply
		w.WaitSignal(replySignal, &r) // blocks (durably) until the poller delivers one
		replies++
		if r.Done {
			break
		}
		follow := replyInput{
			PR:        in.PR,
			InReplyTo: posted.CommentID,
			Body:      fmt.Sprintf("Thanks @%s — noted, I'll take that into account.", r.Author),
		}
		if err := w.ExecuteActivity("replyComment", follow, nil); err != nil {
			return nil, fmt.Errorf("reply comment: %w", err)
		}
	}
	return json.Marshal(reviewSummary{RootCommentID: posted.CommentID, Replies: replies})
}

// StartReview posts the initial comment (synchronously, inside StartWorkflow)
// and launches the background poller. It returns the run ID.
func (m *ReviewManager) StartReview(ctx context.Context, in ReviewCommentInput) (string, error) {
	runID, err := m.engine.StartWorkflow(reviewWorkflow, in)
	if err != nil {
		return "", err
	}
	rootID, err := m.rootCommentID(runID)
	if err != nil {
		return runID, err
	}
	go m.poll(ctx, runID, in.PR, rootID)
	return runID, nil
}

// poll watches the thread and signals the workflow with each new reply until
// the run finishes.
func (m *ReviewManager) poll(ctx context.Context, runID string, pr int, rootID int64) {
	seen := map[int64]bool{}
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			status, err := m.engine.Status(runID)
			if err != nil || status == tembed.StatusCompleted || status == tembed.StatusFailed {
				return
			}
			replies, err := m.gh.FetchReplies(ctx, pr, rootID)
			if err != nil {
				m.logf("review: fetch replies pr=%d root=%d: %v", pr, rootID, err)
				continue
			}
			for _, r := range replies {
				if seen[r.ID] {
					continue
				}
				seen[r.ID] = true
				if err := m.engine.SignalWorkflow(runID, replySignal, r); err != nil {
					m.logf("review: signal run=%s: %v", runID, err)
				}
			}
		}
	}
}

// rootCommentID reads the posted comment ID from the run's recorded history.
func (m *ReviewManager) rootCommentID(runID string) (int64, error) {
	hist, err := m.engine.History(runID)
	if err != nil {
		return 0, err
	}
	for _, ev := range hist {
		if ev.Type == tembed.EventActivityCompleted && ev.Name == "postLineComment" {
			var pr postResult
			if err := json.Unmarshal(ev.Payload, &pr); err != nil {
				return 0, err
			}
			return pr.CommentID, nil
		}
	}
	return 0, fmt.Errorf("review: run %s has no posted comment yet", runID)
}

// ghReviewer is the production GitHubReviewer that shells out to `gh api`.
type ghReviewer struct {
	repo string // owner/name
	// headSHA is required by GitHub to anchor a line comment to a commit.
	headSHA func(ctx context.Context, pr int) (string, error)
}

// newGHReviewer builds a reviewer for repoSlug, resolving the head SHA via gh.
func newGHReviewer() *ghReviewer {
	return &ghReviewer{
		repo: repoSlug,
		headSHA: func(ctx context.Context, pr int) (string, error) {
			meta, err := fetchPRMeta(ctx, pr)
			if err != nil {
				return "", err
			}
			return meta.HeadRefOid, nil
		},
	}
}

// ghComment is the subset of a review comment we read back.
type ghComment struct {
	ID        int64                  `json:"id"`
	Body      string                 `json:"body"`
	User      struct{ Login string } `json:"user"`
	InReplyTo int64                  `json:"in_reply_to_id"`
}

func (g *ghReviewer) PostLineComment(ctx context.Context, pr int, file string, line int, body string) (int64, error) {
	sha, err := g.headSHA(ctx, pr)
	if err != nil {
		return 0, err
	}
	out, err := ghAPI(ctx, "POST",
		fmt.Sprintf("repos/%s/pulls/%d/comments", g.repo, pr),
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

func (g *ghReviewer) Reply(ctx context.Context, pr int, inReplyTo int64, body string) (int64, error) {
	out, err := ghAPI(ctx, "POST",
		fmt.Sprintf("repos/%s/pulls/%d/comments/%d/replies", g.repo, pr, inReplyTo),
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

func (g *ghReviewer) FetchReplies(ctx context.Context, pr int, rootID int64) ([]ReviewReply, error) {
	out, err := ghAPI(ctx, "GET",
		fmt.Sprintf("repos/%s/pulls/%d/comments?per_page=100", g.repo, pr))
	if err != nil {
		return nil, err
	}
	var comments []ghComment
	if err := json.Unmarshal(out, &comments); err != nil {
		return nil, err
	}
	var replies []ReviewReply
	for _, c := range comments {
		if c.InReplyTo != rootID {
			continue
		}
		replies = append(replies, ReviewReply{
			ID:     c.ID,
			Author: c.User.Login,
			Body:   c.Body,
			Done:   strings.Contains(strings.ToLower(c.Body), "/resolve"),
		})
	}
	return replies, nil
}

// ghAPI runs `gh api` with method and args, returning stdout.
func ghAPI(ctx context.Context, method, endpoint string, args ...string) ([]byte, error) {
	full := append([]string{"api", "--method", method, endpoint}, args...)
	cmd := exec.CommandContext(ctx, "gh", full...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh api %s %s: %w", method, endpoint, err)
	}
	return out, nil
}

// newReviewEngine builds a tembed engine for slash that persists to SQLite
// (data/tembed.db) and a JSONL audit trail (data/tembed/) — the combination.
func newReviewEngine(dataDir string) (*tembed.Engine, func() error, error) {
	sq, err := tembed.NewSQLiteStore(dataDir + "/tembed.db")
	if err != nil {
		return nil, nil, err
	}
	jl, err := tembed.NewJSONLStore(dataDir + "/tembed")
	if err != nil {
		sq.Close()
		return nil, nil, err
	}
	store := tembed.NewMultiStore(sq, jl)
	return tembed.New(store), store.Close, nil
}
