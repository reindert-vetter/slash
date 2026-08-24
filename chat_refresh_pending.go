// chat_refresh_pending.go — "which files does the review tree still need to
// re-ingest, right now, for a chat edit this reviewer already landed" for one
// PR — closes the gap between "Claude just landed a commit" (immediately
// visible as the existing `ongepusht` label) and "the block/diff panel
// actually shows the new code" (only true once the ingest-refresh that
// landing triggered, refreshTreeAfterLanding, actually completes). Reviewer
// request: "als claude net een aanpassing heeft gedaan waarom code is
// aangepast/weg is, dan wil ik dat gelijk zien" — `ongepusht` alone says
// nothing about whether the shown CODE has caught up yet, see
// .claude/docs/pending-push.md.
//
// In-memory only, gone after a restart — same operational carve-out as
// chat_edit_pending.go/pending_push.go's own status maps (see
// .claude/rules/workflows-write-boundary.md): nothing here is durable truth.
// Losing it on a restart only means the "wordt bijgewerkt" pill goes dark a
// beat early for a refresh that was already running; the tree itself catches
// up regardless via the ordinary ingest-refresh poller.
//
// Populated in processChatMergeAt (chat_merge.go) right as a landing
// succeeds, from the exact same file set chat_edit_pending.go is about to
// clear (the files the landed turn's own Edit/Write calls touched). Cleared
// once an ingest-refresh actually swapped the blocks table
// (scanAndStoreBlocks/refreshIngestDelta, workflows.go) — the same moment
// `blocks.changed` is published, so the frontend event and this registry go
// dark together.
package main

import (
	"sort"
	"sync"
)

var (
	chatRefreshPendingMu    sync.Mutex
	chatRefreshPendingFiles = map[prKey]map[string]bool{}
)

// markChatRefreshPendingFiles records that files were just landed but the
// review tree hasn't re-ingested them yet — additive, same shape as
// markChatFilesPending: a second landing touching a different file adds to
// the same set rather than replacing it.
func markChatRefreshPendingFiles(repo string, pr int, files []string) {
	if len(files) == 0 {
		return
	}
	key := prKey{Repo: repo, PR: pr}
	chatRefreshPendingMu.Lock()
	defer chatRefreshPendingMu.Unlock()
	set := chatRefreshPendingFiles[key]
	if set == nil {
		set = map[string]bool{}
		chatRefreshPendingFiles[key] = set
	}
	for _, f := range files {
		if f != "" {
			set[f] = true
		}
	}
}

// clearChatRefreshPendingFiles forgets every file pending a re-ingest for
// (repo, pr) — called once an ingest-refresh actually swapped the blocks
// table (see publishBlocksChanged's call sites in workflows.go). Safe to call
// unconditionally: the review tree is now current with everything landed so
// far for this PR, regardless of which specific landing triggered this run.
func clearChatRefreshPendingFiles(repo string, pr int) {
	key := prKey{Repo: repo, PR: pr}
	chatRefreshPendingMu.Lock()
	defer chatRefreshPendingMu.Unlock()
	delete(chatRefreshPendingFiles, key)
}

// chatRefreshPendingFilesFor is the read-only view buildCheckoutView
// (chat_checkout.go) exposes over GET /api/chat/checkout — sorted so the JSON
// response (and any test asserting on it) is deterministic rather than at the
// mercy of Go's own map iteration order.
func chatRefreshPendingFilesFor(repo string, pr int) []string {
	key := prKey{Repo: repo, PR: pr}
	chatRefreshPendingMu.Lock()
	defer chatRefreshPendingMu.Unlock()
	set := chatRefreshPendingFiles[key]
	if len(set) == 0 {
		return nil
	}
	out := make([]string, 0, len(set))
	for f := range set {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}
