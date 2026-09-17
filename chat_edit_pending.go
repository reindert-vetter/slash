// chat_edit_pending.go — "which files does a not-yet-landed Claude edit
// touch, right now" for one PR — the review-tree-wide status a block gets
// while its own file is mid-edit (reviewer request: "mag er een status bij
// elk blok uit dat bestand met dat het bezig met een aanpassing, dat moet weg
// als het is aangepast").
//
// In-memory only, gone after a restart — the same operational carve-out as
// chat_progress.go/pending_push.go's own status maps (see
// .claude/rules/workflows-write-boundary.md): nothing here is the source of
// truth about anything durable. The durable truth is git itself (whether the
// checkout still has an uncommitted/unlanded change for that file) — losing
// this registry on a restart only means the "wordt aangepast" pill goes dark
// a beat early for a turn that was already running, never a correctness
// issue.
//
// Populated from chatProgress.EditedFiles right before a turn's own volatile
// snapshot is cleared (chat_progress.go's finishChatProgress) — accumulated
// PER TURN there because a single Edit/Write tool call's Detail overwrites
// the previous one, but a turn commonly touches more than one file before it
// ends. Cleared as a whole for a PR the moment ANY landing for that PR
// succeeds (chat_merge.go's processChatMergeAt): commitCheckoutEditsAt always
// `git add -A`s the whole checkout, so a successful landing by definition
// carries every file that was pending for that PR at that moment — there is
// no per-file landing to track separately.
package main

import (
	"sort"
	"sync"
)

var (
	chatPendingEditMu    sync.Mutex
	chatPendingEditFiles = map[prKey]map[string]bool{}
	// chatPendingLandExpected says whether a landing for (repo, pr) is still
	// COMING for the files above — the liveness half of the same registry.
	// Set together with the files themselves (a turn that just edited
	// something is followed by its own automatic landing, chat_workflow.go's
	// result.NeedsLand branch) and cleared the moment that stops being true:
	// a landing actually ran (successfully or not, chat_merge.go), or the
	// turn ended in a way that enqueues no landing at all
	// (clearChatLandExpected, see its own doc comment).
	//
	// Without it, dirtyIsOnlyPendingEdits (chat_checkout.go) kept reading a
	// leftover dirty tree as "another conversation is still landing this" for
	// as long as the process lived — reported bug: a CANCELLED write turn
	// left its edits behind, no landing was ever enqueued for them, and every
	// later write turn of that PR waited out the whole chatRetryDelays ladder
	// on a transient "probeer het zo weer" that could never come true.
	chatPendingLandExpected = map[prKey]bool{}
)

// markChatFilesPending records that files are edited but not yet landed for
// (repo, pr) — additive: a second turn/conversation touching a different
// file adds to the same set rather than replacing it.
func markChatFilesPending(repo string, pr int, files []string) {
	if len(files) == 0 {
		return
	}
	key := prKey{Repo: repo, PR: pr}
	chatPendingEditMu.Lock()
	defer chatPendingEditMu.Unlock()
	set := chatPendingEditFiles[key]
	if set == nil {
		set = map[string]bool{}
		chatPendingEditFiles[key] = set
	}
	for _, f := range files {
		if f != "" {
			set[f] = true
		}
	}
	chatPendingLandExpected[key] = true
}

// clearChatPendingFiles forgets every file pending for (repo, pr) — called
// once a landing actually puts them on the PR's pending ref (so the tree
// already reflects them) or once a cancelled turn's own leftovers are
// resolved (discarded/stashed/kept — the turn's lifecycle has ended either
// way, see applyCancelCleanup).
func clearChatPendingFiles(repo string, pr int) {
	key := prKey{Repo: repo, PR: pr}
	chatPendingEditMu.Lock()
	defer chatPendingEditMu.Unlock()
	delete(chatPendingEditFiles, key)
	delete(chatPendingLandExpected, key)
}

// clearChatLandExpected records that no landing is coming for whatever this
// PR's checkout is still holding — the files stay marked as "edited, not
// landed" (the "wordt aangepast" pill is still telling the truth: they really
// are sitting uncommitted in the checkout), but nobody is going to commit
// them on their own any more.
//
// Called for a turn that ended as chat.KindCancelled/chat.KindError AND
// actually changed the checkout: claudeChatWorkflow (chat_workflow.go) skips
// its result.NeedsLand branch for exactly those two kinds, so no landing is
// ever enqueued for their leftovers. From that moment the dirty tree must be
// classified as what it is — an ordinary dirty checkout that needs a reviewer
// decision — instead of "someone else is still landing this", see
// dirtyIsOnlyPendingEdits (chat_checkout.go).
func clearChatLandExpected(repo string, pr int) {
	key := prKey{Repo: repo, PR: pr}
	chatPendingEditMu.Lock()
	defer chatPendingEditMu.Unlock()
	delete(chatPendingLandExpected, key)
}

// chatLandExpected is dirtyIsOnlyPendingEdits' own liveness check: is a
// landing for (repo, pr) still on its way?
func chatLandExpected(repo string, pr int) bool {
	key := prKey{Repo: repo, PR: pr}
	chatPendingEditMu.Lock()
	defer chatPendingEditMu.Unlock()
	return chatPendingLandExpected[key]
}

// chatPendingEditedFilesFor is the read-only view buildCheckoutView (chat_
// checkout.go) exposes over GET /api/chat/checkout — sorted so the JSON
// response (and any test asserting on it) is deterministic rather than at
// the mercy of Go's own map iteration order.
func chatPendingEditedFilesFor(repo string, pr int) []string {
	key := prKey{Repo: repo, PR: pr}
	chatPendingEditMu.Lock()
	defer chatPendingEditMu.Unlock()
	set := chatPendingEditFiles[key]
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
