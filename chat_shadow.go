// chat_shadow.go — the per-conversation "shadow worktree" the claude_chat
// edit path uses: a real, non-detached git checkout on its own local branch
// chat/<conversationId>, based on the PR's live head branch. See
// .claude/rules/tembed-workflows.md ("claude_chat").
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

	dir := chatShadowDir(dataDir, pr, conversationID)
	if _, err := os.Stat(dir); err != nil {
		branch := chatShadowBranch(conversationID)
		if _, err := runGit(ctx, "worktree", "add", "-b", branch, dir, "origin/"+headRefName); err != nil {
			return "", fmt.Errorf("create chat shadow worktree: %w", err)
		}
		return dir, nil
	}

	// Already exists. Only fast-forward it to the live branch tip when there is
	// genuinely nothing pending — an uncommitted edit, or a local commit not yet
	// pushed, must never be silently discarded/rebased; leave it exactly as is
	// and let the next turn/commit attempt degrade instead of guessing (the same
	// "degrade rather than guess" rule the re-anchor pass follows — see the
	// pr_status section of .claude/rules/workflows-trackers.md).
	dirty, ahead, err := chatShadowPendingState(ctx, dir, headRefName)
	if err != nil {
		// Can't tell — be conservative and leave the worktree untouched.
		return dir, nil
	}
	if !dirty && ahead == 0 {
		if _, err := runGitIn(ctx, dir, "reset", "--hard", "origin/"+headRefName); err != nil {
			return "", fmt.Errorf("refresh chat shadow worktree: %w", err)
		}
	}
	return dir, nil
}

// chatShadowPendingState reports whether dir has uncommitted changes, and how
// many commits its own HEAD is ahead of origin/<headRefName> (local commits
// not yet pushed).
func chatShadowPendingState(ctx context.Context, dir, headRefName string) (dirty bool, ahead int, err error) {
	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain")
	if err != nil {
		return false, 0, err
	}
	dirty = strings.TrimSpace(string(statusOut)) != ""
	aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", "origin/"+headRefName+"..HEAD")
	if err != nil {
		return dirty, 0, err
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	return dirty, n, nil
}

// commitChatShadowEdits is the "commit deze wijziging" Activity body: commit
// whatever Claude changed in the conversation's shadow worktree and
// fast-forward-push it straight onto the PR's real head branch via an
// explicit refspec (chat/<id>:<headRef>) — never a force-push. Persists and
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
			Body: "Kon de PR-branch niet bepalen om naartoe te pushen.",
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
	// committed locally without managing to push, so it's still worth trying.

	// git fetch + push touch the shared clone's remote-tracking refs — the same
	// reason ensureChatShadowWorktree takes ingestMu.
	ingestMu.Lock()
	defer ingestMu.Unlock()

	if _, err := runGit(ctx, "fetch", "origin", headRefName); err != nil {
		return newMsg("Kon de laatste stand van de branch niet ophalen.", true)
	}
	aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", "HEAD..origin/"+headRefName)
	if err != nil {
		return newMsg("Kon niet controleren of de branch intussen is doorgelopen.", true)
	}
	if strings.TrimSpace(string(aheadOut)) != "0" {
		return newMsg("De PR-branch is intussen verder; jouw wijziging kon niet worden gepusht. Ververs en probeer opnieuw.", true)
	}

	branch := chatShadowBranch(conversationID)
	refspec := branch + ":" + headRefName
	// No --force anywhere here: git itself refuses a non-fast-forward push, on
	// top of the ahead-check above.
	if _, err := runGitIn(ctx, dir, "push", "origin", refspec); err != nil {
		return newMsg("Pushen naar de PR-branch is mislukt.", true)
	}

	// Reclaim: nothing is left to represent now that the shadow matches the new
	// head — a future edit turn re-materializes it lazily from the (now
	// updated) head. Best-effort; a leftover directory/branch is still swept by
	// cleanup.go once the PR itself is purged.
	_, _ = runGit(ctx, "worktree", "remove", "--force", dir)
	_, _ = runGit(ctx, "branch", "-D", branch)

	return newMsg(fmt.Sprintf("Wijziging gepusht naar `%s`.", headRefName), false)
}
