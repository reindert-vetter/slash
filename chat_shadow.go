// chat_shadow.go — the per-conversation "shadow worktree" the claude_chat
// edit path uses: a real, non-detached git checkout on its own local branch
// chat/<conversationId>, based on the PR's live head branch. See
// .claude/docs/tembed-workflows.md ("claude_chat").
//
// Deliberately NOT the shared base/head worktrees ingest.go owns
// (worktreeDirs) — those are pinned to an exact SHA and read by /api/code,
// blockstats.go, the re-anchor pass and the ingest-refresh poller, all of
// which assume they stay exactly at the recorded head_sha. Repurposing either
// for direct edits (or switching either to a branch checkout) would break
// every one of those invariants. This is a THIRD, disposable worktree, one per
// conversation, used only to let Claude's Edit tool touch real files and to
// commit/push the result — never read by anything else in the app.
//
// No separate DB bookkeeping is needed: the worktree's existence and identity
// (which PR, which conversation) are fully derivable from its own directory
// name (chatShadowDir), and its git state (dirty? ahead of the remote
// branch?) is read live from git itself whenever it matters.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"slash/modules/chat"
)

// chatShadowDir returns the absolute path of one conversation's shadow
// worktree. The "chatshadow-<conversationId>" suffix (as opposed to base/head)
// keeps it out of ingest.go's own worktreeDirs and lets cleanup.go's own
// worktree-name scan find and sweep it independently (see reWorktreeDir /
// removePRWorktrees in cleanup.go).
func chatShadowDir(dataDir string, pr int, conversationID string) string {
	root, err := filepath.Abs(dataDir)
	if err != nil {
		root = dataDir
	}
	return filepath.Join(root, "worktrees", fmt.Sprintf("pr-%d-chatshadow-%s", pr, conversationID))
}

// chatShadowBranch is the local branch name a conversation's shadow worktree
// is checked out on — distinct per conversation (git disallows two worktrees
// checked out on the same branch at once), based on the PR's real head branch
// at creation time.
func chatShadowBranch(conversationID string) string {
	return "chat/" + conversationID
}

// prPendingRef is the LOCAL ref one PR's committed-but-not-yet-pushed chat
// edits land on — "the PR's branch as slash knows it locally". Deliberately
// its own refs/slash/... namespace instead of refs/heads/<headRef>: the clone
// runGit works in is the developer's OWN checkout, where a real local branch
// of that name may already exist (possibly checked out), and moving it under
// the reviewer's feet is exactly the kind of surprise this app must never
// cause. A ref outside refs/heads never shows up in `git branch`, can't
// collide with a checkout, and pushes just as well
// (<pendingRef>:refs/heads/<headRef>, see pushPendingPR in chat_merge.go).
//
// The branch name is part of the ref PATH so every reader can recover it from
// git alone (`git for-each-ref refs/slash/pending/pr-<n>/`) without a gh call —
// that is what keeps the pending-push read model (tasks_api.go) purely local.
func prPendingRef(pr int, headRefName string) string {
	return fmt.Sprintf("refs/slash/pending/pr-%d/%s", pr, headRefName)
}

// pendingRefSHA resolves ref to a commit SHA, or "" when it doesn't exist
// (which is the normal state: no chat edit has landed for this PR yet).
func pendingRefSHA(ctx context.Context, ref string) string {
	out, err := runGit(ctx, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// chatShadowBaseTip is the ref a conversation's shadow worktree is created
// from / fast-forwarded to: the PR's pending ref when one exists, else
// origin/<headRefName>. Basing on the pending ref is what makes two
// conversations STACK instead of clobbering each other — the second one starts
// from the first one's already-landed (but unpushed) commit, rather than from
// an origin tip that doesn't contain it yet.
func chatShadowBaseTip(ctx context.Context, pr int, headRefName string) string {
	ref := prPendingRef(pr, headRefName)
	if pendingRefSHA(ctx, ref) != "" {
		return ref
	}
	return "origin/" + headRefName
}

// chatShadowMissingTips reports which of the two tips a landing must contain —
// origin/<headRefName> and the PR's pending ref, in that FIXED order — are not
// yet ancestors of dir's HEAD. Empty means the shadow's own commit contains
// everything and may land as a plain fast-forward.
//
// Both tips matter: the pending ref is the local truth a landing may never
// rewind (another conversation's unpushed work), and the origin tip is what
// the eventual push has to fast-forward onto. A non-empty result is exactly
// the "branch moved on" situation resolveChatShadowMerge (chat_merge.go)
// merges away, one tip at a time, in this same order.
// No error return on purpose: `merge-base --is-ancestor` answers "no" with exit
// code 1, indistinguishable here from a genuine git failure, and both belong in
// the same place — report the tip as missing and let the merge path deal with
// it. A false "missing" costs one no-op merge, never correctness.
func chatShadowMissingTips(ctx context.Context, dir string, pr int, headRefName string) []string {
	candidates := []string{"origin/" + headRefName, prPendingRef(pr, headRefName)}
	var missing []string
	for _, ref := range candidates {
		if pendingRefSHA(ctx, ref) == "" {
			continue // doesn't exist locally (no pending ref yet) — nothing to contain
		}
		if _, err := runGitIn(ctx, dir, "merge-base", "--is-ancestor", ref, "HEAD"); err != nil {
			missing = append(missing, ref)
		}
	}
	return missing
}

// ensureChatShadowWorktree lazily creates (on the conversation's first edit
// turn) or, if it's safe to, refreshes a conversation's shadow worktree, and
// returns its directory.
//
// Locked with ingestMu because `git worktree add`/`git fetch` mutate the
// shared local clone's own metadata (.git/worktrees, refs/remotes/...) — the
// same reason ingest.go's worktree operations take that lock; two concurrent
// worktree-add/fetch calls on the same underlying clone is exactly the class
// of race ingestMu already exists to serialize. Deliberately NOT held for the
// whole edit turn: only this git-plumbing step needs it, never the claude
// subprocess call or a local `git commit` inside the now-exclusive worktree
// directory (those touch only that one conversation's own branch/files, never
// shared clone state — different conversations get different branch refs),
// so unrelated conversations' edit turns still run fully concurrently.
func ensureChatShadowWorktree(ctx context.Context, dataDir string, pr int, conversationID string) (string, error) {
	meta, err := fetchPRMeta(ctx, pr)
	if err != nil {
		return "", fmt.Errorf("fetch pr meta: %w", err)
	}
	if meta.HeadRefName == "" {
		return "", fmt.Errorf("pr %d: gh reported no head branch name", pr)
	}
	return ensureChatShadowWorktreeAt(ctx, dataDir, pr, conversationID, meta.HeadRefName)
}

// ensureChatShadowWorktreeAt is ensureChatShadowWorktree's body once the PR's
// head branch name is already known — split out purely for testability: it
// touches only local/`origin`-remote git plumbing (no gh/network call), so a
// test can point SLASH_REPO_DIR at a throwaway local repo and exercise the
// real worktree/branch/fetch/reset mechanics offline (mirrors why
// scanAndStoreIngestBlocksLocked exists next to scanAndStoreIngestBlocks in
// ingest.go, though that split is about mutex re-entrancy rather than tests).
func ensureChatShadowWorktreeAt(ctx context.Context, dataDir string, pr int, conversationID, headRefName string) (string, error) {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	if _, err := runGit(ctx, "fetch", "origin", headRefName); err != nil {
		return "", fmt.Errorf("fetch head branch %s: %w", headRefName, err)
	}

	// Based on the PR's LOCAL landing tip, not blindly on origin: an earlier
	// conversation's already-landed-but-unpushed commit must be the starting
	// point, or this conversation's own landing would try to rewind it (see
	// chatShadowBaseTip / prPendingRef).
	tip := chatShadowBaseTip(ctx, pr, headRefName)

	dir := chatShadowDir(dataDir, pr, conversationID)
	if _, err := os.Stat(dir); err != nil {
		branch := chatShadowBranch(conversationID)
		// -c submodule.recurse=false: the reviewed repo (plug-and-pay) carries
		// real submodules (forks/nova, modules/Ai) that this shadow worktree
		// never needs — Claude only edits app code, never a submodule's own
		// content. Without this, an active submodule (forks/nova is
		// `active=true` in the shared clone's config, and the shared clone sets
		// submodule.recurse=true) makes git try to (re)initialize a PER-WORKTREE
		// submodule gitdir under <clone>/.git/worktrees/<name>/modules/..., which
		// can fail partway (no credentials/network for a second, separate clone
		// in this subprocess's environment) and leave a half-initialized gitdir
		// (just a `config` file, no HEAD/objects/refs) behind. See
		// .claude/docs/workflows-comments.md ("Agentic edits") for the full
		// incident writeup.
		if _, err := runGit(ctx, "-c", "submodule.recurse=false", "worktree", "add", "-b", branch, dir, tip); err != nil {
			return "", fmt.Errorf("create chat shadow worktree: %w", err)
		}
		return dir, nil
	}

	// Already exists. Only fast-forward it to the live branch tip when there is
	// genuinely nothing pending — an uncommitted edit, or a local commit not yet
	// pushed, must never be silently discarded/rebased; leave it exactly as is
	// and let the next turn/commit attempt degrade instead of guessing (the same
	// "degrade rather than guess" rule the re-anchor pass follows — see the
	// pr_status section of .claude/docs/workflows-trackers.md).
	dirty, ahead, err := chatShadowPendingState(ctx, dir, tip)
	if err != nil {
		// Can't tell — be conservative and leave the worktree untouched.
		return dir, nil
	}
	if !dirty && ahead == 0 {
		// Same -c submodule.recurse=false as the worktree-add above: a plain
		// `reset --hard` here is exactly what used to try to reset a submodule's
		// index/working tree (git-reset(1)'s own --recurse-submodules gate) and
		// hit the half-initialized gitdir left behind by a prior attempt —
		// "fatal: not a git repository: .../modules/forks/nova" / "fatal: could
		// not reset submodule index". With recursion off, reset never touches
		// the submodule gitlink at all, which also makes this call self-healing
		// for a shadow worktree that got wedged by an OLDER build of this code.
		if _, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "reset", "--hard", tip); err != nil {
			return "", fmt.Errorf("refresh chat shadow worktree: %w", err)
		}
	}
	return dir, nil
}

// chatShadowPendingState reports whether dir has uncommitted changes, and how
// many commits its own HEAD is ahead of tip (local commits that have not landed
// on the PR's pending ref yet — see chatShadowBaseTip for what tip is).
func chatShadowPendingState(ctx context.Context, dir, tip string) (dirty bool, ahead int, err error) {
	// --ignore-submodules=all: a submodule's own content is never part of what
	// makes this shadow "dirty" (Claude never edits forks/nova/modules/Ai), and
	// without this flag `git status` opens the submodule gitdir to check it —
	// which fails outright on an already wedged one (see the reset comment
	// above), turning "can't tell, leave it alone" into a permanent no-op.
	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return false, 0, err
	}
	dirty = strings.TrimSpace(string(statusOut)) != ""
	aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", tip+"..HEAD")
	if err != nil {
		return dirty, 0, err
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	return dirty, n, nil
}

// chatShadowLocalPendingState is chatShadowPendingState's LOCAL-ONLY sibling:
// no live `git fetch`/gh call, just two git plumbing reads against whatever is
// already on disk — cheap enough to run synchronously from an HTTP handler.
// "ahead" is measured against every already-known remote-tracking ref
// (`--not --remotes`) rather than specifically origin/<headRef> (which would
// need a live gh lookup to resolve) — good enough to answer "is there
// exclusively-local work here worth warning about" without touching the
// network. Used by handleChatShadowStatus (tasks_api.go, the read-only check
// the UI runs BEFORE warning the reviewer about "wis gesprek") and by
// clearChatShadow below, so both agree on what counts as "pending".
func chatShadowLocalPendingState(ctx context.Context, dir string) (dirty bool, ahead int, err error) {
	// --ignore-submodules=all: same reason as chatShadowPendingState above —
	// submodule content is never what "pending" means here, and status would
	// otherwise choke on an already wedged submodule gitdir.
	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return false, 0, err
	}
	dirty = strings.TrimSpace(string(statusOut)) != ""
	aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		return dirty, 0, err
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	return dirty, n, nil
}

// chatShadowNeedsLanding is runOneClaudeTurn's own end-of-turn check (tasks 1
// + 2 + 4, see "Automatic landing after a shell turn" in
// .claude/docs/workflows-comments.md): does this conversation's shadow
// worktree have anything — an uncommitted edit, or a local commit — that
// hasn't made it onto the PR's pending ref yet? Reuses
// chatShadowLocalPendingState (the same cheap, local-only check the
// shadow-status endpoint already runs), so this never touches the network.
//
// Deliberately checked regardless of whether THIS turn escalated to the
// shell: an earlier turn/attempt may have committed locally without managing
// to land (a transient landing failure, or a reviewer message split across
// several Claude turns before asking to commit) — every turn is a chance to
// notice and land it, so nothing sits unlanded (and therefore invisible in
// the review tree) longer than necessary.
func chatShadowNeedsLanding(ctx context.Context, dataDir string, pr int, conversationID string) bool {
	dir := chatShadowDir(dataDir, pr, conversationID)
	if _, err := os.Stat(dir); err != nil {
		return false
	}
	dirty, ahead, err := chatShadowLocalPendingState(ctx, dir)
	if err != nil {
		return false
	}
	return dirty || ahead > 0
}

// clearChatShadow is "wis gesprek"'s (chatActionClear) best-effort removal of
// a conversation's agentic-edit shadow worktree + branch, called from the
// clearChatConversation Activity right after the transcript itself is wiped.
// The reviewer already saw a warning (chatShadowLocalPendingState via the
// shadow-status endpoint) naming any pending work before confirming the
// clear, so this proceeds unconditionally — never a Go error, only logged,
// mirroring every other best-effort git/GitHub call in this file. A no-op
// when no shadow worktree exists for this conversation.
func clearChatShadow(ctx context.Context, tm *TaskManager, dataDir string, pr int, conversationID string) {
	dir := chatShadowDir(dataDir, pr, conversationID)
	if _, err := os.Stat(dir); err != nil {
		return
	}
	ingestMu.Lock()
	defer ingestMu.Unlock()
	if _, err := runGit(ctx, "worktree", "remove", "--force", dir); err != nil {
		if tm != nil && tm.logf != nil {
			tm.logf("claude_chat: clear could not remove shadow worktree %s: %v", dir, err)
		}
		return
	}
	if _, err := runGit(ctx, "branch", "-D", chatShadowBranch(conversationID)); err != nil {
		if tm != nil && tm.logf != nil {
			tm.logf("claude_chat: clear could not delete shadow branch for conversation %s: %v", conversationID, err)
		}
	}
}

// prepareChatReadOnlyWorkDir is runOneClaudeTurn's entry point into the CHEAP
// first attempt of every turn (task 3, see the "Two-step tool access" section
// in .claude/docs/workflows-comments.md): a plain os.Stat against the PR's
// already-ingested, shared HEAD worktree (worktreeDirs, ingest.go) — never the
// per-conversation shadow. No git fetch, no ingestMu lock, no gh call at all:
// this directory is already on disk for any PR a comment (hence a chat) can
// exist on, and it is read by several other callers (blockstats.go, /api/code)
// without any locking, so a concurrent Read/Grep/Glob tool call here is no
// riskier than those.
//
// Returns false only when the directory genuinely isn't there yet (a PR that
// was never ingested — not reachable in practice for an existing comment
// thread, but degrading gracefully costs nothing).
func prepareChatReadOnlyWorkDir(dataDir string, pr int) (string, bool) {
	_, headDir := worktreeDirs(dataDir, pr)
	if _, err := os.Stat(headDir); err != nil {
		return "", false
	}
	return headDir, true
}

// prepareChatShellWorkDir is runOneClaudeTurn's own entry point into the
// shadow-worktree machinery above: it wraps ensureChatShadowWorktree and turns
// ANY failure (gh unreachable, no network, git plumbing error) into a plain
// "not available this turn" signal instead of an error the caller has to
// propagate. This is the graceful-degrade half of
// .claude/rules/workflows-write-boundary.md's "Exception: the Claude chat
// turn may act through a shell" — every turn tries to get shell/file access,
// but a reviewer just chatting must never see a FAILURE turn merely because
// gh/git happened to be unreachable at that moment; the turn simply falls
// back to a tool-less completion (see runOneClaudeTurn). Logged best-effort
// via tm.logf, same convention as chat_merge.go's own degrade logging — the
// exact reason stays server-log-only, but the DEGRADATION itself is not
// silent: runOneClaudeTurn sets chat.Message.NoShell on the turn's own reply,
// which ClaudeChat.mjs shows as a "Geen bestandstoegang" pill — a reviewer
// must be able to tell that Claude answered without looking at the code.
func prepareChatShellWorkDir(ctx context.Context, tm *TaskManager, dataDir string, pr int, conversationID string) (string, bool) {
	dir, err := ensureChatShadowWorktree(ctx, dataDir, pr, conversationID)
	if err != nil {
		if tm != nil && tm.logf != nil {
			tm.logf("claude_chat: shadow worktree unavailable for pr %d conversation %s, degrading to a tool-less turn: %v", pr, conversationID, err)
		}
		return "", false
	}
	return dir, true
}

// chatShadowBranchMovedOnMsg is the exact reviewer-facing text
// commitChatShadowEditsAt reports when the PR's branch has moved on since the
// shadow was based (so the landing would not be a fast-forward). Named so
// chat_merge.go can detect this SPECIFIC outcome (as opposed to "no shadow
// exists"/"couldn't determine the PR branch"/a genuine git failure) without
// string-matching an inline literal in two places — a shared constant can't
// drift out of sync.
const chatShadowBranchMovedOnMsg = "De PR-branch is intussen verder; jouw wijziging kon niet worden geland. Ververs en probeer opnieuw."

// landAndReclaimChatShadow lands dir's commit on the PR's LOCAL pending ref
// (prPendingRef) and, only once that succeeds, reclaims the now-superfluous
// shadow worktree + branch (best-effort; a leftover is still swept by
// cleanup.go once the PR is purged). Shared by commitChatShadowEditsAt's own
// fast-forward path and chat_merge.go's merge/conflict-resolution path, so
// there is exactly one place that ever moves a PR's pending ref forward.
//
// This REPLACES the direct `git push origin chat/<id>:<headRef>` this function
// used to do. The push to GitHub is now a separate, reviewer-triggered step
// (the todo row at the bottom of the block index → the chat_merge queue's
// "push" Signal → pushPendingPR), so a reviewer-requested edit is immediately
// part of the PR branch as slash sees it — and immediately visible in the
// review tree — without a network write nobody asked for yet.
//
// git's own non-fast-forward refusal is gone with the push, so the guarantee is
// kept here explicitly: the ref only ever moves to a commit that CONTAINS its
// current value. Callers already check the same thing against both tips
// (chatShadowMissingTips); this is the last line of defence, so no code path
// can silently rewind another conversation's unpushed work.
//
// ingestMu-guarded: update-ref/worktree-remove/branch-delete all touch the
// shared clone's own refs and worktree registry — the same reason
// ensureChatShadowWorktreeAt takes this lock.
func landAndReclaimChatShadow(ctx context.Context, dir string, pr int, conversationID, headRefName string) error {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	shaOut, err := runGitIn(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("resolve shadow HEAD: %w", err)
	}
	sha := strings.TrimSpace(string(shaOut))

	ref := prPendingRef(pr, headRefName)
	if cur := pendingRefSHA(ctx, ref); cur != "" && cur != sha {
		if _, err := runGitIn(ctx, dir, "merge-base", "--is-ancestor", cur, sha); err != nil {
			return fmt.Errorf("landing %s would not be a fast-forward of %s", short(sha), short(cur))
		}
	}
	if _, err := runGit(ctx, "update-ref", ref, sha); err != nil {
		return fmt.Errorf("update pending ref: %w", err)
	}

	branch := chatShadowBranch(conversationID)
	_, _ = runGit(ctx, "worktree", "remove", "--force", dir)
	_, _ = runGit(ctx, "branch", "-D", branch)
	return nil
}

// chatShadowConflictedPaths reports the paths git still considers unmerged in
// dir (non-empty only right after a `git merge`/`git rebase` left conflict
// markers) — the authoritative "is this really a conflict" check, used both to
// decide whether an automatic `git merge` needs Claude's help and, afterwards,
// to verify Claude actually resolved it rather than trusting its own claim.
func chatShadowConflictedPaths(ctx context.Context, dir string) ([]string, error) {
	out, err := runGitIn(ctx, dir, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil, nil
	}
	return strings.Split(trimmed, "\n"), nil
}

// commitChatShadowEdits is the "commit deze wijziging" Activity body: commit
// whatever Claude changed in the conversation's shadow worktree and land it,
// fast-forward-only, on the PR's LOCAL pending ref (landAndReclaimChatShadow) —
// the push to GitHub is a separate, reviewer-triggered step. Persists and
// returns the resulting chat.Message (success, or a specific reviewer-facing
// failure reason). An ordinary "nothing to commit" or "branch moved on"
// outcome is expected, normal behaviour — never a Go error — only a genuinely
// unexpected git/gh failure would be, and even those are reported to the
// reviewer as a message rather than failing the workflow (mirrors
// runOneClaudeTurn's own failed-claude-call handling).
func commitChatShadowEdits(ctx context.Context, cm *chat.Module, dataDir string, pr int, conversationID, turnID string) chat.Message {
	meta, err := fetchPRMeta(ctx, pr)
	if err != nil || meta.HeadRefName == "" {
		msg := chat.Message{
			ID: chatMessageID(turnID, ""), ConversationID: conversationID, PR: pr,
			Role: "assistant", Kind: chat.KindError,
			Body: "Kon de PR-branch niet bepalen om de wijziging op te landen.",
		}
		_ = cm.SaveMessage(ctx, msg)
		return msg
	}
	return commitChatShadowEditsAt(ctx, cm, dataDir, pr, conversationID, turnID, meta.HeadRefName)
}

// commitChatShadowEditsAt is commitChatShadowEdits's body once the PR's head
// branch name is already known — split out for the same testability reason as
// ensureChatShadowWorktreeAt: no gh/network call, only local/`origin`-remote
// git plumbing, so a test can exercise the real commit/fetch/ahead-check/push
// mechanics (including the fast-forward-only conflict path) against a
// throwaway local repo.
func commitChatShadowEditsAt(ctx context.Context, cm *chat.Module, dataDir string, pr int, conversationID, turnID, headRefName string) chat.Message {
	newMsg := func(body string, isErr bool) chat.Message {
		kind := ""
		if isErr {
			kind = chat.KindError
		}
		msg := chat.Message{
			ID: chatMessageID(turnID, ""), ConversationID: conversationID, PR: pr,
			Role: "assistant", Kind: kind, Body: body,
		}
		_ = cm.SaveMessage(ctx, msg)
		return msg
	}

	dir := chatShadowDir(dataDir, pr, conversationID)
	if _, err := os.Stat(dir); err != nil {
		return newMsg("Er is nog geen Claude-wijziging klaargezet om te committen.", true)
	}

	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain")
	if err != nil {
		return newMsg("Kon de status van de wijziging niet bepalen.", true)
	}
	if strings.TrimSpace(string(statusOut)) != "" {
		if _, err := runGitIn(ctx, dir, "add", "-A"); err != nil {
			return newMsg("Kon de wijziging niet stagen.", true)
		}
		if _, err := runGitIn(ctx, dir, "commit", "-m", "Claude: reviewer-requested edit"); err != nil {
			return newMsg("Kon de wijziging niet committen.", true)
		}
	}
	// Else: nothing new to stage — but an earlier attempt may already have
	// committed locally without managing to land, so it's still worth trying.

	// git fetch touches the shared clone's remote-tracking refs — the same
	// reason ensureChatShadowWorktree takes ingestMu. Scoped to JUST the fetch +
	// containment check: the landing itself takes the same lock again, on its
	// own, inside landAndReclaimChatShadow — a plain sync.Mutex isn't reentrant,
	// so it must be released here first rather than deferred.
	ingestMu.Lock()
	_, fetchErr := runGit(ctx, "fetch", "origin", headRefName)
	if fetchErr != nil {
		ingestMu.Unlock()
		return newMsg("Kon de laatste stand van de branch niet ophalen.", true)
	}
	missing := chatShadowMissingTips(ctx, dir, pr, headRefName)
	ingestMu.Unlock()
	if len(missing) > 0 {
		return newMsg(chatShadowBranchMovedOnMsg, true)
	}

	if err := landAndReclaimChatShadow(ctx, dir, pr, conversationID, headRefName); err != nil {
		return newMsg("De wijziging kon niet op de PR-branch worden gezet.", true)
	}

	return newMsg(pendingLandedMsg(headRefName), false)
}

// pendingLandedMsg is the reviewer-facing text for a successful landing — the
// one place that wording lives, so the plain fast-forward path and
// chat_merge.go's merge paths can't describe the same outcome differently. It
// says two things on purpose: the change IS on the PR branch as slash sees it
// (so the review tree showing it right away is not a surprise), and it is NOT
// on GitHub yet, with a pointer at where the push lives.
func pendingLandedMsg(headRefName string) string {
	return fmt.Sprintf("Wijziging staat op `%s` en is meteen zichtbaar in de review-tree. "+
		"Nog niet gepusht naar GitHub — dat doe je met de todo onderaan de index.", headRefName)
}
