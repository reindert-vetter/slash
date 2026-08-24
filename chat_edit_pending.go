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
