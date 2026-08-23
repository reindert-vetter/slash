// pending_push.go — everything around the ONE thing a landed chat edit still
// needs: getting pushed to GitHub.
//
// A reviewer-requested Claude edit is committed and landed on a local ref per
// PR (prPendingRef, chat_shadow.go) so it is part of the PR's branch — and
// visible in the review tree — immediately, without a network write. The push
// itself is a separate, deliberate step the reviewer fires from the todo row at
// the bottom of the block index (src/BlockList.mjs), which reaches the PR's
// existing chat_merge queue as a "push" request. That queue is what serializes
// it against a landing that may be in flight for the same PR.
//
// This file holds the three halves of that: reading the pending state out of
// git (purely local, no gh call — which is why the ref carries the branch name
// in its own path), the push Activity itself, and the volatile "pushing/failed"
// status the todo row shows.
package main

import (
	"context"
	"strconv"
	"strings"
	"sync"
)

// pendingPushState values for pendingPushView.State. Deliberately words, not
// colours: the reviewer is colour-blind, so the row must read correctly without
// any hue (see the row itself in src/BlockList.mjs).
const (
	pendingPushReady   = "ready"   // landed commits waiting for a push
	pendingPushPushing = "pushing" // a push Activity is running right now
	pendingPushFailed  = "failed"  // the last push attempt failed; ref kept, retry allowed
)

// pendingPushView is the read model behind GET /api/pending-push: one PR's
// not-yet-pushed landed commits.
type pendingPushView struct {
	PR      int      `json:"pr"`
	HeadRef string   `json:"headRef"`
	SHA     string   `json:"sha"`
	Ahead   int      `json:"ahead"`
	Files   []string `json:"files,omitempty"`
	State   string   `json:"state"`
	// PushRunID is the chat_merge queue's own (deterministic) Run ID, so the UI
	// can signal the push without deriving a Go-side id itself — the same shape
	// as state.approveRunId. Present whenever there is anything to push; a
	// signal to a queue that isn't live fails loudly instead of silently doing
	// nothing, which the row surfaces as "push mislukt" and a retry.
	PushRunID string `json:"pushRunId,omitempty"`
	// Error is the last push failure's reason, for the row's own detail line.
	Error string `json:"error,omitempty"`
}

// pendingPushStatus is the volatile half of the read model: whether a push is
// running right now and why the last one failed. In-memory only, gone after a
// restart, no read-model or workflow-history write — the same operational
// carve-out as the heartbeat map and chat_progress.go (see
// .claude/rules/workflows-write-boundary.md). The DURABLE truth is git itself:
// the pending ref either still exists (not pushed) or doesn't (pushed).
var pendingPushStatus = struct {
	sync.Mutex
	byPR map[prKey]pendingPushView
}{byPR: map[prKey]pendingPushView{}}

func setPendingPushState(repo string, pr int, state, errMsg string) {
	pendingPushStatus.Lock()
	defer pendingPushStatus.Unlock()
	if state == "" {
		delete(pendingPushStatus.byPR, prKey{repo, pr})
		return
	}
	pendingPushStatus.byPR[prKey{repo, pr}] = pendingPushView{PR: pr, State: state, Error: errMsg}
}

func pendingPushStateOf(repo string, pr int) (state, errMsg string) {
	pendingPushStatus.Lock()
	defer pendingPushStatus.Unlock()
	v := pendingPushStatus.byPR[prKey{repo, pr}]
	return v.State, v.Error
}

// pendingPushRefFor finds the PR's pending ref and the head-branch name encoded
// in its path (prPendingRef). Returns "", "" when nothing has landed.
//
// Enumerating rather than constructing the ref is what keeps this purely local:
// the branch name is not stored anywhere in slash's own DB, so asking git for
// the ref it already has beats a gh lookup on every read. A PR whose head
// branch was renamed can briefly leave two refs; the most recently committed
// one wins, and the stale one is swept with the PR (cleanup.go).
func pendingPushRefFor(ctx context.Context, repo string, pr int) (ref, headRef string) {
	prefix := pendingRefPrefix(repo, pr)
	out, err := runGitFor(ctx, repo, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", prefix)
	if err != nil {
		return "", ""
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, prefix) {
			continue
		}
		return line, strings.TrimPrefix(line, prefix)
	}
	return "", ""
}

// loadPendingPush reads one PR's pending-push state straight out of git, or nil
// when nothing is waiting to be pushed. Read-only and local-only: three git
// plumbing reads, no fetch, no gh — cheap enough for a plain GET handler and for
// the PR-overview list to ask about several PRs at once.
func loadPendingPush(ctx context.Context, repo string, pr int) *pendingPushView {
	ref, headRef := pendingPushRefFor(ctx, repo, pr)
	if ref == "" {
		// Nothing landed. A "failed" status left over from an earlier attempt is
		// meaningless now, so drop it rather than keep reporting it.
		setPendingPushState(repo, pr, "", "")
		return nil
	}
	sha := pendingRefSHA(ctx, repo, ref)
	if sha == "" {
		return nil
	}
	v := &pendingPushView{PR: pr, HeadRef: headRef, SHA: sha, Ahead: 1, State: pendingPushReady}
	// origin/<headRef> is whatever the last fetch left behind — deliberately not
	// refreshed here (a GET must stay cheap and offline-safe), so these two are
	// a good-enough display count/file list, never a decision input: the push
	// itself re-checks against the real remote.
	base := "origin/" + headRef
	if pendingRefSHA(ctx, repo, base) != "" {
		if out, err := runGitFor(ctx, repo, "rev-list", "--count", base+".."+ref); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil && n > 0 {
				v.Ahead = n
			}
		}
		if out, err := runGitFor(ctx, repo, "diff", "--name-only", base, ref); err == nil {
			for _, f := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				if f = strings.TrimSpace(f); f != "" {
					v.Files = append(v.Files, f)
				}
			}
		}
	}
	if state, errMsg := pendingPushStateOf(repo, pr); state != "" {
		v.State, v.Error = state, errMsg
	}
	v.PushRunID = chatMergeQueueRunID(repo, pr)
	return v
}

// pushPendingPR is the pushPendingPR Activity's body: push one PR's pending ref
// onto its real head branch and, only once that succeeded, drop the ref.
//
// Runs on the PR's chat_merge queue (the "push" Action of its existing merge
// Signal), so it can never overlap a landing for the same PR — the exact reason
// that queue exists.
//
// Never --force and never a rewrite: the refspec is <pendingRef>:<headRef> and
// git itself refuses a non-fast-forward push, which is the whole guarantee. A
// refused push is normal, expected behaviour (someone else pushed meanwhile),
// not a Go error: the ref is KEPT so the reviewer can merge the newer tip in
// via a fresh chat commit and try again, and the failure is reported through
// the volatile status the todo row reads.
func pushPendingPR(ctx context.Context, tm *TaskManager, repo string, pr int) {
	ref, headRef := pendingPushRefFor(ctx, repo, pr)
	if ref == "" {
		setPendingPushState(repo, pr, "", "")
		publishPendingPushChanged(repo, pr)
		return
	}

	setPendingPushState(repo, pr, pendingPushPushing, "")
	publishPendingPushChanged(repo, pr)

	// ingestMu-guarded like every other operation on the shared clone's refs
	// (see prepareChatShellWorkDir/advancePendingRefFromCheckout, chat_checkout.go).
	ingestMu.Lock()
	_, err := runGitFor(ctx, repo, "push", "origin", ref+":refs/heads/"+headRef)
	ingestMu.Unlock()
	if err != nil {
		setPendingPushState(repo, pr, pendingPushFailed, pushFailureReason(err))
		if tm != nil && tm.logf != nil {
			tm.logf("pending push: pr %d push %s failed: %v", pr, headRef, err)
		}
		publishPendingPushChanged(repo, pr)
		return
	}

	// Pushed: the commits are on GitHub now, so the local pending ref has served
	// its purpose. Dropping it is what makes the todo row disappear and what
	// lets pollIngestRefresh fall back to its plain equality check
	// (ingestRefreshNeeded) — remote and ingested head are the same commit again.
	ingestMu.Lock()
	_, delErr := runGitFor(ctx, repo, "update-ref", "-d", ref)
	ingestMu.Unlock()
	if delErr != nil && tm != nil && tm.logf != nil {
		tm.logf("pending push: pr %d pushed but could not drop %s: %v", pr, ref, delErr)
	}
	setPendingPushState(repo, pr, "", "")
	publishPendingPushChanged(repo, pr)
}

// pushFailureReason reduces a git push failure to one short line for the todo
// row. The common case by far is a non-fast-forward, which deserves a sentence
// the reviewer can act on rather than git's own multi-line hint block.
func pushFailureReason(err error) string {
	msg := err.Error()
	if strings.Contains(msg, "non-fast-forward") || strings.Contains(msg, "fetch first") || strings.Contains(msg, "rejected") {
		return "De branch op GitHub is verder gelopen. Vraag Claude de wijziging samen te voegen met de huidige stand en probeer daarna opnieuw."
	}
	if i := strings.IndexByte(msg, '\n'); i > 0 {
		msg = msg[:i]
	}
	return msg
}

// removePendingRefs deletes every pending ref of a PR — used when the PR itself
// is purged (cleanup.go). Best-effort, like every other git call in that sweep.
func removePendingRefs(ctx context.Context, repo string, pr int) {
	prefix := pendingRefPrefix(repo, pr)
	out, err := runGitFor(ctx, repo, "for-each-ref", "--format=%(refname)", prefix)
	if err != nil {
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			_, _ = runGitFor(ctx, repo, "update-ref", "-d", line)
		}
	}
	setPendingPushState(repo, pr, "", "")
}
