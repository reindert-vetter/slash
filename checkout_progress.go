package main

import (
	"context"
	"strings"
	"sync"
	"time"
)

// checkoutProgressStep is one real `git` command a checkout-menu Activity
// (checkoutRelist/checkoutAnswer/checkoutOff/checkoutRestoreStash,
// workflows.go/chat_checkout.go) ran while resolving the reviewer's choice,
// plus its outcome — surfaced to the werkmap overlay
// (src/workDirOverlay.mjs) so its "Bezig…" state shows what is actually
// happening (e.g. "git stash push -u -m …") instead of a bare label repeat.
//
// Purely operational: an in-memory-only log per PR that Activities append to
// while they run, gone on a restart. Falls outside the workflows-write-
// boundary rule for the same reason ingest_progress.go/
// comment_batch_progress.go do (see
// .claude/rules/workflows-write-boundary.md): no module, no read-model, no
// workflow-history write, and nothing here is the source of truth about
// anything — the durable outcome of a checkout-menu action is whatever
// buildCheckoutView reports afterwards (the assignment/decision itself), not
// this log.
type checkoutProgressStep struct {
	Cmd    string `json:"cmd"` // e.g. "git stash push -u -m slash-chat-…"
	Ok     bool   `json:"ok"`
	Output string `json:"output,omitempty"` // trimmed combined stdout+stderr
	At     int64  `json:"at"`               // unix millis, so the UI can order entries as they arrive
}

// checkoutProgressMaxSteps/checkoutProgressMaxOutputLen cap memory: a single
// Activity run's own git commands never come close to either limit in
// practice, this is only a backstop against something looping.
const (
	checkoutProgressMaxSteps     = 30
	checkoutProgressMaxOutputLen = 400
)

var (
	checkoutProgressMu sync.Mutex
	checkoutProgressBy = map[prKey][]checkoutProgressStep{}
)

// clearCheckoutProgress resets one PR's step log — called at the start of
// each of the four checkout-menu Activities (workflows.go) so a previous
// answer's steps never bleed into a new one.
func clearCheckoutProgress(repo string, pr int) {
	checkoutProgressMu.Lock()
	defer checkoutProgressMu.Unlock()
	delete(checkoutProgressBy, prKey{Repo: repo, PR: pr})
}

// checkoutProgressSteps reads the current step log for one PR
// (GET /api/chat/checkout/progress) — a copy, so the caller/JSON encoder
// never races the Activity still appending to it.
func checkoutProgressSteps(repo string, pr int) []checkoutProgressStep {
	checkoutProgressMu.Lock()
	defer checkoutProgressMu.Unlock()
	steps := checkoutProgressBy[prKey{Repo: repo, PR: pr}]
	out := make([]checkoutProgressStep, len(steps))
	copy(out, steps)
	return out
}

func appendCheckoutProgressStep(repo string, pr int, step checkoutProgressStep) {
	checkoutProgressMu.Lock()
	defer checkoutProgressMu.Unlock()
	key := prKey{Repo: repo, PR: pr}
	steps := append(checkoutProgressBy[key], step)
	if len(steps) > checkoutProgressMaxSteps {
		steps = steps[len(steps)-checkoutProgressMaxSteps:]
	}
	checkoutProgressBy[key] = steps
}

// checkoutProgressCtxKey/withCheckoutProgress/recordCheckoutProgressGit thread
// "which PR is this git command for" through the many existing runGitIn call
// sites in chat_checkout.go (discardCheckoutDirty, stashCheckoutDirty,
// classifyCheckoutCandidate, commitCheckoutEditsAt, …) with no change needed
// at any of them: only the four checkout-menu Activity entry points
// (workflows.go) wrap their ctx once, via withCheckoutProgress, right after
// clearing the previous log.
type checkoutProgressCtxKey struct{}

type checkoutProgressMarker struct {
	repo string
	pr   int
}

func withCheckoutProgress(ctx context.Context, repo string, pr int) context.Context {
	return context.WithValue(ctx, checkoutProgressCtxKey{}, checkoutProgressMarker{repo: repo, pr: pr})
}

// recordCheckoutProgressGit is called from runGitIn (gh.go) for every command
// it runs. A no-op unless ctx carries the marker withCheckoutProgress set —
// every OTHER runGitIn call site in the codebase (ingest worktrees, the
// re-anchor pass, …) is completely unaffected, since their ctx never carries
// it.
func recordCheckoutProgressGit(ctx context.Context, args []string, out []byte, err error) {
	marker, ok := ctx.Value(checkoutProgressCtxKey{}).(checkoutProgressMarker)
	if !ok {
		return
	}
	output := strings.TrimSpace(string(out))
	if len(output) > checkoutProgressMaxOutputLen {
		output = output[:checkoutProgressMaxOutputLen] + "…"
	}
	appendCheckoutProgressStep(marker.repo, marker.pr, checkoutProgressStep{
		Cmd:    "git " + strings.Join(args, " "),
		Ok:     err == nil,
		Output: output,
		At:     time.Now().UnixMilli(),
	})
}
