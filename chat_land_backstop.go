// chat_land_backstop.go — the self-healing recovery for a chat edit that was
// COMMITTED in the PR's shared local checkout but never LANDED on the PR's
// pending ref, so the review tree never re-ingested it and the reviewer's
// browser kept showing the pre-edit diff.
//
// Reviewer report: "ik zie nog niet in de diff dat het weg is. het moet het
// weghalen in de browser". Reconstructed on PR 13606: Claude removed an
// `isPaused()` check and committed it itself (via the Bash carve-out, see
// .claude/rules/workflows-write-boundary.md), but the turn's own
// runClaudeTurn Activity result recorded `needsLand: false`
// (turnChangedCheckout && chatCheckoutNeedsLanding, workflows.go), so no
// landing was ever enqueued: no pending ref, no ingest refresh, no
// `blocks.changed`, no `⇧ ongepusht` pill — nothing reached the tab at all,
// and nothing ever re-checked. The commit sat in the reviewer's checkout
// while the head worktree (and therefore the diff, /api/code and every
// read-only chat turn) stayed on the older commit indefinitely.
//
// Both halves of that decision are turn-scoped and answer `false` on ANY git
// error, so they cannot be made reliable by inspection alone — hence this
// backstop, which is derived from git + the ingest table only and therefore
// needs no event, no in-memory turn baseline and no chat turn at all. Same
// reasoning as pendingPushView.TreeCaughtUp's backstop for a missed
// `blocks.changed` frame (.claude/docs/pending-push.md): the recovery reads
// the truth itself instead of correlating two volatile signals.
//
// Deliberately NARROW, so it can be fully automatic (reviewer's own call:
// "automatisch herstellen"):
//
//   - Only a CLEAN checkout qualifies. commitCheckoutEditsAt does `git add -A`
//     on a dirty tree, which would sweep the reviewer's own unrelated work
//     into a commit behind his back. A dirty tree is also never silent — the
//     "wordt aangepast"/"wordt bijgewerkt" pills cover that state — so
//     declining here loses nothing.
//   - Only while the checkout really sits on the PR's own head branch.
//   - Only for a local commit that origin does not have yet, and that is not
//     already the pending ref's own tip or the ingested head.
//   - At most one attempt per (PR, sha) per process, so a landing that keeps
//     refusing (a non-fast-forward, see advancePendingRefFromCheckout) is
//     logged once instead of every poll tick.
//
// The repair itself is the ORDINARY landing: one `merge` Signal on the PR's
// existing chat_merge queue, which serializes it against every other landing
// for that PR and then does the whole existing chain (fetch the commit into
// the shared clone, advance the pending ref, refreshTreeAfterLanding →
// refreshIngestDelta → `blocks.changed` with landedFiles → the tab's own
// auto-refresh). No new write path, and the request carries no conversation:
// nobody asked for it in a chat, so it records no chat bubble either (see
// saveChatOutcomeMessage).
package main

import (
	"context"
	"log"
	"strings"
	"sync"
)

var (
	landBackstopMu sync.Mutex
	// landBackstopTried is the per-PR "which checkout sha did this process
	// already try to land through the backstop" guard. In-memory only, gone
	// after a restart, never the source of truth about anything — losing it
	// only means one extra attempt for a sha that is very likely long since
	// landed anyway. Same operational carve-out as pendingPushStatus.
	landBackstopTried = map[prKey]string{}
)

// unlandedCheckoutCommit reports the PR checkout's HEAD sha when that commit
// exists only locally and never made it onto the PR's pending ref — i.e. a
// landing that should have happened and didn't. "" means "nothing to repair"
// for every other case, including every git error (logged, never guessed at).
//
// ingestedHead is the head SHA the blocks table was last built from
// (loadIngestSHAs), passed in rather than read here so this stays a pure
// git-only check the tests can drive against a throwaway repo.
func unlandedCheckoutCommit(ctx context.Context, dataDir, repo string, pr int, ingestedHead string) string {
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil || a.Dir == "" || a.Branch == "" {
		return ""
	}
	// Deliberately the plain porcelain status (no --ignore-submodules), so
	// this sees exactly what commitCheckoutEditsAt would stage.
	statusOut, err := runGitIn(ctx, a.Dir, "status", "--porcelain")
	if err != nil {
		log.Printf("chat_merge: landing backstop pr=%d: status in %s: %v", pr, a.Dir, err)
		return ""
	}
	if strings.TrimSpace(string(statusOut)) != "" {
		return "" // the reviewer's own work may be in there — never commit that unasked
	}
	branchOut, err := runGitIn(ctx, a.Dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		log.Printf("chat_merge: landing backstop pr=%d: branch in %s: %v", pr, a.Dir, err)
		return ""
	}
	if strings.TrimSpace(string(branchOut)) != a.Branch {
		return "" // checked out on something else entirely
	}
	headOut, err := runGitIn(ctx, a.Dir, "rev-parse", "HEAD")
	if err != nil {
		log.Printf("chat_merge: landing backstop pr=%d: head in %s: %v", pr, a.Dir, err)
		return ""
	}
	head := strings.TrimSpace(string(headOut))
	if head == "" || head == ingestedHead {
		return ""
	}
	if landed := pendingRefSHA(ctx, repo, prPendingRef(repo, pr, a.Branch)); landed == head {
		return "" // already landed, the tree just hasn't finished refreshing
	}
	aheadOut, err := runGitIn(ctx, a.Dir, "rev-list", "--count", "origin/"+a.Branch+"..HEAD")
	if err != nil {
		// No local origin/<branch> to measure against: the ordinary landing
		// path bails on that too (commitCheckoutEditsAt), so don't guess.
		log.Printf("chat_merge: landing backstop pr=%d: ahead count in %s: %v", pr, a.Dir, err)
		return ""
	}
	if strings.TrimSpace(string(aheadOut)) == "0" {
		return "" // origin already has it — the reviewer pushed it himself
	}
	return head
}

// repairMissedLanding is checkIngestRefreshOnce's own local-only first step
// (workflows.go): it enqueues the ordinary landing for a commit the checkout
// holds but the pending ref never got. Runs on the same heartbeat-driven
// cadence as the ingest-refresh check itself, plus once on every "open a
// review tree" page load (TriggerIngestRefreshCheck), so a missed landing is
// repaired within one tick of the tab being open instead of never.
//
// A Signal, never a direct write — the landing itself stays inside the
// chat_merge queue's own Activity (.claude/rules/workflows-write-boundary.md).
// Best-effort/log-only, the same shape as the ingest-refresh Signal right
// below it.
func (m *TaskManager) repairMissedLanding(ctx context.Context, repo string, pr int) {
	if m.engine == nil || m.db == nil {
		return
	}
	_, head, ok, err := loadIngestSHAs(m.db, repo, pr)
	if err != nil || !ok {
		return // no prior ingest at all: nothing to bring up to date yet
	}
	sha := unlandedCheckoutCommit(ctx, m.dataDir, repo, pr, head)
	if sha == "" {
		return
	}
	key := prKey{Repo: repo, PR: pr}
	landBackstopMu.Lock()
	already := landBackstopTried[key] == sha
	landBackstopTried[key] = sha
	landBackstopMu.Unlock()
	if already {
		return
	}
	runID, err := m.EnsureChatMergeQueue(repo, pr)
	if err != nil {
		m.logf("chat_merge: landing backstop pr=%d: no queue: %v", pr, err)
		return
	}
	m.logf("chat_merge: landing backstop pr=%d: local commit %s was never landed, enqueueing a landing", pr, short(sha))
	if err := m.engine.SignalWorkflow(runID, SignalChatMerge, ChatMergeRequest{}); err != nil {
		m.logf("chat_merge: landing backstop pr=%d: signal: %v", pr, err)
	}
}
