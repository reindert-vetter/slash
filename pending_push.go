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
	"database/sql"
	"strconv"
	"strings"
	"sync"
	"time"
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
	// TreeCaughtUp reports whether the review tree's own ingested head SHA
	// (pr_ingest, the same row refreshIngestDelta writes) already equals SHA —
	// i.e. whether the ingest-refresh this landing triggered has actually run,
	// regardless of whether the blocks.changed SSE frame announcing it ever
	// reached a particular browser tab. See "the auto-refresh backstop" below
	// and .claude/docs/pending-push.md's "Wordt bijgewerkt" section: that frame
	// is deliberately excluded from onEventsResync (a bare reconnect must never
	// raise a false stale-tree notice), and the ordinary poller
	// (pollIngestRefresh/ingestRefreshNeeded) can never fill the gap for THIS
	// case because it only reacts to the PR's REMOTE head moving — a landed,
	// not-yet-pushed local commit never does that. loadPendingPush is polled
	// independently of that SSE frame (git-backed, not event-sourced), so a tab
	// that missed the one frame still eventually observes TreeCaughtUp flip to
	// true and can catch itself up.
	TreeCaughtUp bool `json:"treeCaughtUp"`
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

// ingestCaughtUpWithPendingRef reports whether the review tree's own recorded
// ingest head (pr_ingest.head_sha, written only by scanAndStoreBlocks/
// refreshIngestDelta) already equals sha — the pending ref's current commit.
// db may be nil (a caller with no graph DB in hand, e.g. most of
// pending_push_test.go, which doesn't exercise this field) or there may be no
// prior ingest at all yet; both report caught-up (true) rather than a false
// "still behind" that could never resolve — a PR with no full ingest has
// nothing for a chat edit to land against in the first place.
func ingestCaughtUpWithPendingRef(db *sql.DB, repo string, pr int, sha string) bool {
	if db == nil || sha == "" {
		return true
	}
	_, head, ok, err := loadIngestSHAs(db, repo, pr)
	if err != nil || !ok {
		return true
	}
	return head == sha
}

// remoteHeadTTL is how long one `git ls-remote` answer is reused. The read
// model behind it is polled (every 10s per open tab, plus a batch per
// PR-overview render), so without a cache a network round trip would ride
// along on every tick; with it, at most one per PR per minute — and only for a
// PR that actually has landed, not-yet-pushed work.
const remoteHeadTTL = 60 * time.Second

// remoteHeadTimeout bounds the one network call, so an unreachable origin
// degrades to "unknown" (and thus to the purely local fallback below) instead
// of stalling a GET handler.
const remoteHeadTimeout = 8 * time.Second

// remoteHeadCache is the volatile memo behind remoteHeadSHA: in-memory only,
// gone after a restart, no module/read-model/workflow-history write — the same
// operational carve-out as pendingPushStatus right above (see
// .claude/rules/workflows-write-boundary.md). A failure is cached too (as ""),
// so an offline machine retries once a minute rather than on every poll.
var remoteHeadCache = struct {
	sync.Mutex
	byPR map[prKey]remoteHeadEntry
}{byPR: map[prKey]remoteHeadEntry{}}

type remoteHeadEntry struct {
	sha string
	at  time.Time
}

// remoteHeadSHA is the PR head branch's REAL tip on GitHub, or "" when that
// cannot be established right now (offline, no such branch, git failing).
//
// Deliberately `ls-remote` and NOT a fetch: it writes nothing at all — no
// objects, no remote-tracking ref — so this stays a pure read of somebody
// else's state, exactly like the rest of loadPendingPush. A fetch would also
// work, but it would mutate the reviewer's own clone from a polled GET.
//
// Why it is needed at all: origin/<headRef> in the shared clone is only ever
// as fresh as the last fetch that happened to include that branch, and nothing
// in slash ever does one — ensureCommits (gh.go) fetches refs/pull/<n>/head,
// which does not move origin/<branch>, and the chat checkout fetches in the
// reviewer's OWN checkout, not here. So a reviewer who pushes his branch
// himself leaves this clone believing the pending commits are still local,
// forever. Measured on a real PR: origin/<headRef> six days and 293 commits
// behind, which reported "293 commits nog niet gepusht" and marked nearly
// every file in the PR with the "ongepusht" pill.
func remoteHeadSHA(ctx context.Context, repo string, pr int, headRef string) string {
	if headRef == "" {
		return ""
	}
	key := prKey{repo, pr}
	now := time.Now()

	remoteHeadCache.Lock()
	if e, ok := remoteHeadCache.byPR[key]; ok && now.Sub(e.at) < remoteHeadTTL {
		remoteHeadCache.Unlock()
		return e.sha
	}
	remoteHeadCache.Unlock()

	cctx, cancel := context.WithTimeout(ctx, remoteHeadTimeout)
	defer cancel()

	sha := ""
	if out, err := runGitFor(cctx, repo, "ls-remote", "--heads", "origin", headRef); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			f := strings.Fields(strings.TrimSpace(line))
			if len(f) == 2 && f[1] == "refs/heads/"+headRef {
				sha = f[0]
				break
			}
		}
	}

	remoteHeadCache.Lock()
	remoteHeadCache.byPR[key] = remoteHeadEntry{sha: sha, at: now}
	remoteHeadCache.Unlock()
	return sha
}

// commitContains reports whether ancestor is already part of descendant's
// history. Both commits must be present locally; a missing one makes git fail,
// which reports false — "unknown" must never hide real work.
func commitContains(ctx context.Context, repo, ancestor, descendant string) bool {
	if ancestor == "" || descendant == "" {
		return false
	}
	_, err := runGitFor(ctx, repo, "merge-base", "--is-ancestor", ancestor, descendant)
	return err == nil
}

// commitParents returns sha's own parent SHAs, in order. Empty on any git
// error (a missing/unreadable sha) or for a root commit with none.
func commitParents(ctx context.Context, repo, sha string) []string {
	out, err := runGitFor(ctx, repo, "log", "-1", "--format=%P", sha)
	if err != nil {
		return nil
	}
	return strings.Fields(strings.TrimSpace(string(out)))
}

// mergeCommitSupersededByRemote reports whether sha is a plain merge commit
// (exactly two parents — never a single-parent commit, which always carries
// its OWN authored content and is never safe to wave off) whose BOTH parents
// are already ancestors of base.
//
// Real case this covers (PR 13628, INTEG-467): a reviewer-requested chat turn
// ran `git merge origin/develop` and landed it as
// refs/slash/pending/pr-<n>/<headRef>. The branch's own real work (the
// merge's first parent) was already on GitHub. Afterwards the branch was
// updated on GitHub itself with a SEPARATE, later merge of develop (e.g. via
// GitHub's "Update branch" button) — a different commit, since git never
// reuses another merge's SHA, so the pending ref could never become an
// ancestor of the new remote tip and the ahead-count could never reach 0 (see
// the count==0 case above): a permanently stuck "ongepusht" pill on a PR that
// really had nothing left to push, contradicting the reviewer's own claim.
//
// A merge commit contributes nothing beyond what its two parents already
// carry — that's the definition of a merge (no third input). So once BOTH
// parents are independently confirmed to already be on the remote, the merge
// itself cannot hold anything the remote doesn't also already have, even
// though the merge SHA itself never will be. This only applies to a genuine
// two-parent merge commit; a single-parent commit (real authored work) is
// never treated this way, no matter how many of its own ancestors are on the
// remote.
func mergeCommitSupersededByRemote(ctx context.Context, repo, sha, base string) bool {
	parents := commitParents(ctx, repo, sha)
	if len(parents) != 2 {
		return false
	}
	return commitContains(ctx, repo, parents[0], base) && commitContains(ctx, repo, parents[1], base)
}

// loadPendingPush reads one PR's pending-push state straight out of git, or nil
// when nothing is waiting to be pushed. Read-only: a handful of git plumbing
// reads plus one local DB read, no fetch, no gh — cheap enough for a plain GET
// handler and for the PR-overview list to ask about several PRs at once. The
// one thing it is NOT is purely local: it asks the remote for the head
// branch's tip (remoteHeadSHA above, throttled to once a minute per PR and
// only for a PR with landed work), because nothing else in this clone ever
// learns that a branch was pushed from somewhere else.
func loadPendingPush(ctx context.Context, db *sql.DB, repo string, pr int) *pendingPushView {
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
	v := &pendingPushView{
		PR: pr, HeadRef: headRef, SHA: sha, Ahead: 1, State: pendingPushReady,
		TreeCaughtUp: ingestCaughtUpWithPendingRef(db, repo, pr, sha),
	}
	// What the pending commits are measured AGAINST. First choice is the
	// branch's real remote tip: if the pending ref is already contained in it,
	// this work IS on GitHub — whether the app pushed it (and then failed to
	// drop the ref) or the reviewer pushed the branch himself from his own
	// checkout — and reporting it would keep a stale "ongepusht" pill on every
	// touched block forever. The orphaned ref itself is deliberately NOT
	// deleted here: this is a polled GET, and a git write on every tick — next
	// to a landing that may be in flight for the same PR — buys nothing. It is
	// swept with the PR (removePendingRefs, cleanup.go).
	//
	// Fallback, when the remote cannot be reached or its tip isn't a commit we
	// have locally: origin/<headRef>, whatever the last fetch left behind. That
	// is the pre-existing behaviour and is a good-enough display count/file
	// list, never a decision input — the push itself re-checks against the real
	// remote.
	base := "origin/" + headRef
	// Only ask the remote when the local tracking ref does not already prove the
	// work is pushed. That keeps the common cases network-free — nothing landed
	// yet, or the reviewer pushed through THIS clone, which moves
	// origin/<headRef> itself — and it means remoteHeadSHA's one-minute memo can
	// never outvote a fresher local fact.
	if !commitContains(ctx, repo, sha, base) {
		if remote := remoteHeadSHA(ctx, repo, pr, headRef); remote != "" {
			if remote == sha || commitContains(ctx, repo, sha, remote) {
				setPendingPushState(repo, pr, "", "")
				return nil
			}
			if pendingRefSHA(ctx, repo, remote) != "" {
				base = remote
			}
		}
	}
	if pendingRefSHA(ctx, repo, base) != "" {
		// A merge commit that only reincorporates the mainline branch (no
		// unique authored content of its own) and whose two parents are BOTH
		// already on the remote is superseded, not unpushed — see
		// mergeCommitSupersededByRemote's own doc comment (PR 13628).
		if mergeCommitSupersededByRemote(ctx, repo, sha, base) {
			setPendingPushState(repo, pr, "", "")
			return nil
		}
		if out, err := runGitFor(ctx, repo, "rev-list", "--count", base+".."+ref); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil {
				if n == 0 {
					// Same conclusion as the containment check above, reached
					// from the fallback base: the pending ref is already part of
					// the last known origin/<headRef>, so these commits are on
					// GitHub. A count of 0 is the only value that proves it;
					// anything else (base unknown, or the read failing) stays
					// pending, since "unknown" must never hide real work.
					setPendingPushState(repo, pr, "", "")
					return nil
				}
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
