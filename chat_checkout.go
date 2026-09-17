// chat_checkout.go — where a claude_chat write turn actually edits files.
//
// REPLACES the old per-conversation, disposable `git worktree` (chat_shadow.go,
// now this file) with a real, standing local checkout the REVIEWER already has
// on their own machine — see todo/todo-local-checkout-chat-edits.md (kept
// local/uncommitted; this file is its implementation). One checkout is
// resolved ONCE per PR (not per conversation) and remembered for the rest of
// the review: every conversation of that PR edits the SAME directory, on the
// PR's own real branch, directly — no disposable branch, no worktree.
//
// Selection ladder (see the design doc, "Selectie-algoritme"):
//
//  1. The repo's explicit `chatCheckoutDirs` in settings.json (re-read fresh
//     on every resolution — a newly added path works without a restart).
//  2. If that yields nothing usable: a bounded scan of the reviewer's home
//     directory for any git checkout whose remote matches the repo's slug
//     EXACTLY (no forks).
//  3. If still nothing, but directories of this repo were merely HELD BACK
//     (claimed by another PR, or rejected by the reviewer earlier — see
//     checkoutHoldback): the same ladder runs once more with nothing held
//     back, and every usable directory is offered as an explicit choice,
//     each labelled with the reason it first fell out, plus a "Geen van
//     deze" way out. Never auto-picked.
//  4. Only if even that finds nothing: no candidate at all — the write turn
//     reports what it DID see (checkoutDiscovery.reason) and asks the
//     reviewer to configure or clone one; there is NO fallback to a
//     disposable worktree any more.
//
// A candidate is only eligible when it is ALREADY on the PR's own branch, or
// on some other branch that is already merged into the repo's base branch
// (i.e. genuinely free, not someone else's unfinished work). Several eligible
// candidates -> the reviewer always chooses. A dirty working tree, or local
// commits that would not fast-forward, or reusing a freed-but-different
// branch -> a forceful, structured consult (chat.KindDirectoryDecision, see
// modules/chat) BEFORE anything is touched, never a silent guess.
//
// The whole write turn (not just the eventual commit) is serialized per PR
// (chat_write_gate.go) — this shared checkout has no per-conversation
// isolation any more, unlike the old worktree.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"slash/modules/chat"
	"slash/modules/claude"
)

// ---------------------------------------------------------------------------
// The PR's pending ref — unchanged mechanism, now a pure MIRROR (never a
// merge source): a write turn commits directly onto the checkout's own real
// branch, so there is no second, disposable branch to reconcile against any
// more. The shared clone still needs to know about that commit (the
// pending-push read model, the todo row, refreshTreeAfterLanding all read it
// there, never from the reviewer's personal checkout) — see
// advancePendingRefFromCheckout below.
// ---------------------------------------------------------------------------

// prPendingRef is the LOCAL ref one PR's committed-but-not-yet-pushed chat
// edits land on — "the PR's branch as slash knows it locally". Deliberately
// its own refs/slash/... namespace instead of refs/heads/<headRef>: the clone
// runGit works in is the developer's OWN checkout, where a real local branch
// of that name may already exist (possibly checked out), and moving it under
// the reviewer's feet is exactly the kind of surprise this app must never
// cause. A ref outside refs/heads never shows up in `git branch`, can't
// collide with a checkout, and pushes just as well
// (<pendingRef>:refs/heads/<headRef>, see pushPendingPR in chat_merge.go).
func prPendingRef(repo string, pr int, headRefName string) string {
	return pendingRefPrefix(repo, pr) + headRefName
}

// pendingRefPrefix is the ref-path prefix shared by prPendingRef and every
// reader that enumerates a PR's pending refs (pendingPushRefFor/
// removePendingRefs in pending_push.go) — kept in ONE place so the two sides
// can never drift apart again.
func pendingRefPrefix(repo string, pr int) string {
	if repo != "" {
		return fmt.Sprintf("refs/slash/pending/%s/pr-%d/", repoKeyOf(repo), pr)
	}
	return fmt.Sprintf("refs/slash/pending/pr-%d/", pr)
}

// pendingRefSHA resolves ref to a commit SHA, or "" when it doesn't exist
// (which is the normal state: no chat edit has landed for this PR yet).
func pendingRefSHA(ctx context.Context, repo, ref string) string {
	out, err := runGitFor(ctx, repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// ---------------------------------------------------------------------------
// The read-only first attempt — UNCHANGED. Every turn tries this first, and
// most turns never need anything more (see "Two-step tool access",
// .claude/docs/workflows-comments.md).
// ---------------------------------------------------------------------------

// prepareChatReadOnlyWorkDir is runOneClaudeTurn's entry point into the CHEAP
// first attempt of every turn: a plain os.Stat against the PR's already-
// ingested, shared HEAD worktree (worktreeDirs, ingest.go). No git fetch, no
// lock, no gh call at all: this directory is already on disk for any PR a
// comment (hence a chat) can exist on, and it is read by several other
// callers (blockstats.go, /api/code) without any locking, so a concurrent
// Read/Grep/Glob tool call here is no riskier than those.
//
// ONE exception, and it is what makes the answers trustworthy: when the PR's
// own assigned checkout (chat_checkout.go) is further along than that
// worktree, the read-only turn reads the CHECKOUT instead. Reviewer report
// (PR 13606): two conversations of the same PR gave opposite answers to "is
// dit nu weg in de repo?" — one read the checkout (where Claude's edit had
// been committed) and one read the head worktree, which was still on the
// pre-edit commit because that landing never happened (see
// chat_land_backstop.go). Answering "nee, hij staat er nog: <file>:83" from a
// stale worktree is worse than any locking concern this trades away: it is
// confidently wrong about the reviewer's own change.
//
// Deliberately narrow, so nothing else changes: only a checkout that is
// really sitting on the PR's own head branch and whose HEAD *contains* the
// commit the tree was built from (strictly further along, never merely
// different — a checkout that was simply never pulled is BEHIND the tree).
// Being dirty is fine here — unlike a
// landing, a read never commits anything, and uncommitted work is exactly
// what the reviewer is asking about. Falls back to the worktree whenever
// git cannot answer.
func prepareChatReadOnlyWorkDir(ctx context.Context, dataDir string, repo string, pr int) (string, bool) {
	_, headDir := worktreeDirs(dataDir, repo, pr)
	if dir, ok := checkoutAheadOfWorktree(ctx, dataDir, repo, pr, headDir); ok {
		return dir, true
	}
	if _, err := os.Stat(headDir); err != nil {
		return "", false
	}
	return headDir, true
}

// checkoutAheadOfWorktree reports the PR's assigned checkout when it holds a
// state the ingested head worktree does not have yet — see
// prepareChatReadOnlyWorkDir for why a read-only turn then prefers it.
func checkoutAheadOfWorktree(ctx context.Context, dataDir, repo string, pr int, headDir string) (string, bool) {
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil || a.Dir == "" || a.Branch == "" {
		return "", false
	}
	branchOut, err := runGitIn(ctx, a.Dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil || strings.TrimSpace(string(branchOut)) != a.Branch {
		return "", false
	}
	headOut, err := runGitIn(ctx, a.Dir, "rev-parse", "HEAD")
	if err != nil {
		return "", false
	}
	head := strings.TrimSpace(string(headOut))
	if head == "" {
		return "", false
	}
	treeOut, err := runGitIn(ctx, headDir, "rev-parse", "HEAD")
	if err != nil {
		return "", false // no usable worktree to compare against
	}
	tree := strings.TrimSpace(string(treeOut))
	if tree == "" || tree == head {
		return "", false // the tree already shows this exact commit
	}
	// "Further along" means STRICTLY that: the checkout must contain the
	// commit the tree was built from. A checkout that merely differs can just
	// as easily be BEHIND (a colleague pushed, the tree refreshed, this
	// directory was never pulled), and reading that would make the answers
	// worse rather than better. An unknown object errors out here and falls
	// back to the worktree, same as any other git failure above.
	if _, err := runGitIn(ctx, a.Dir, "merge-base", "--is-ancestor", tree, head); err != nil {
		return "", false
	}
	return a.Dir, true
}

// ---------------------------------------------------------------------------
// Candidate discovery and classification
// ---------------------------------------------------------------------------

// checkoutCandidate is one local directory that MIGHT be usable for a PR's
// write turns, plus everything the selection ladder needs to know about it.
type checkoutCandidate struct {
	Dir    string
	Branch string
	// Dirty: uncommitted changes in the working tree.
	Dirty bool
	// DirtyPaths: the repo-relative paths `git status --porcelain` reported,
	// parsed once here (from the same status call Dirty is derived from, no
	// extra `git` invocation) so a caller can tell WHICH paths are dirty
	// without a second `snapshotDirtyPaths` round trip — see
	// dirtyIsOnlyPendingEdits, which compares this against
	// chatPendingEditedFilesFor to tell the reviewer's own unrelated mess
	// apart from another conversation's not-yet-landed edit.
	DirtyPaths []string
	// OnTargetBranch: currently checked out on the PR's own head branch.
	OnTargetBranch bool
	// FastForwardable is only meaningful when OnTargetBranch: HEAD is an
	// ancestor of origin/<headRef> (no local commits origin doesn't have), so
	// fast-forwarding forward is safe. False means real local history that
	// must not be silently discarded.
	FastForwardable bool
	// BehindOrigin is only meaningful when OnTargetBranch && FastForwardable:
	// origin has commits this checkout doesn't have yet.
	BehindOrigin bool
	// MergedIntoBase is only meaningful when !OnTargetBranch: the candidate's
	// current branch is already merged into the repo's base branch, i.e. it
	// is genuinely FREE rather than someone's unfinished, unrelated work.
	MergedIntoBase bool
	// SyncUnknown: `origin` could not be reached while classifying (no
	// network, no credentials, an ssh-agent without the key loaded), so
	// everything above was decided from the remote-tracking refs already on
	// disk. Never a reason to drop the candidate — see
	// classifyCheckoutCandidate — only a reason not to trust "behind origin".
	SyncUnknown bool
}

// fetchOriginBranch refreshes dir's own remote-tracking ref for branch.
// Returns the error for the CALLER to weigh; no caller in this file treats it
// as fatal on its own any more (see classifyCheckoutCandidate).
func fetchOriginBranch(ctx context.Context, dir, branch string) error {
	_, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "fetch", "origin", branch)
	return err
}

// originRefExists reports whether dir already has a local remote-tracking ref
// for origin/<branch> — i.e. whether a failed fetch still leaves something
// (possibly stale, never wrong) to compare against.
func originRefExists(ctx context.Context, dir, branch string) bool {
	_, err := runGitIn(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+branch+"^{commit}")
	return err == nil
}

// classifyCheckoutCandidate reads (and, via `git fetch`, refreshes the
// remote-tracking refs of) dir's current state. Never mutates the working
// tree or the checked-out branch itself.
//
// A FAILING FETCH IS NOT AN ERROR HERE. It used to be, and that made the
// whole feature depend on the server process having working GitHub
// credentials at that exact moment: an ssh-agent with no key loaded, a VPN
// hiccup or plain offline work made every `git fetch` fail, every candidate
// return an error, the candidate list come back empty, and the write turn
// tell the reviewer "add a path to chatCheckoutDirs in settings.json" — a
// configuration problem that did not exist, on a machine where the correct
// checkout was sitting right there, already on the PR's branch. Reaching
// origin only ever REFRESHES what we compare against; the answers this
// function gives (which branch, dirty or not, ahead/behind, merged into base)
// all come from refs that are already on disk. So an unreachable origin
// degrades to "decide from what we have" and marks the candidate SyncUnknown,
// which only suppresses the one action that genuinely needs fresh data (the
// fast-forward in prepareChatShellWorkDirAt).
func classifyCheckoutCandidate(ctx context.Context, dir, headRef, baseBranch string) (checkoutCandidate, error) {
	branchOut, err := runGitIn(ctx, dir, "symbolic-ref", "--short", "-q", "HEAD")
	if err != nil {
		return checkoutCandidate{}, fmt.Errorf("detached HEAD or unreadable branch in %s: %w", dir, err)
	}
	branch := strings.TrimSpace(string(branchOut))

	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return checkoutCandidate{}, err
	}
	c := checkoutCandidate{
		Dir: dir, Branch: branch,
		Dirty:          strings.TrimSpace(string(statusOut)) != "",
		DirtyPaths:     parseGitStatusPaths(statusOut),
		OnTargetBranch: branch == headRef,
	}

	if c.OnTargetBranch {
		c.SyncUnknown = fetchOriginBranch(ctx, dir, headRef) != nil
		if !originRefExists(ctx, dir, headRef) {
			// Nothing local to compare against either (a branch this checkout
			// has never seen from origin). Committing on top is still safe —
			// that is all a write turn ever does — so treat it as usable and
			// simply never fast-forward it.
			c.SyncUnknown = true
			c.FastForwardable = true
			c.BehindOrigin = false
			return c, nil
		}
		aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", "origin/"+headRef+"..HEAD")
		if err != nil {
			return checkoutCandidate{}, err
		}
		ahead, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
		behindOut, err := runGitIn(ctx, dir, "rev-list", "--count", "HEAD..origin/"+headRef)
		if err != nil {
			return checkoutCandidate{}, err
		}
		behind, _ := strconv.Atoi(strings.TrimSpace(string(behindOut)))
		c.FastForwardable = ahead == 0
		// "Behind" measured against a ref we could not refresh says nothing
		// about origin's real state, and acting on it (fastForwardCheckoutToOrigin)
		// would re-run the very fetch that just failed.
		c.BehindOrigin = behind > 0 && !c.SyncUnknown
		return c, nil
	}

	// A different branch is only ever a candidate at all when it is already
	// merged into the base branch — see the package doc comment. Same
	// degrade-gracefully rule as above: the fetch is a refresh, the answer
	// comes from the local refs/remotes/origin/<base> either way.
	if err := fetchOriginBranch(ctx, dir, baseBranch); err != nil {
		c.SyncUnknown = true
	}
	if originRefExists(ctx, dir, baseBranch) {
		if _, err := runGitIn(ctx, dir, "merge-base", "--is-ancestor", branch, "origin/"+baseBranch); err == nil {
			c.MergedIntoBase = true
		}
	}
	return c, nil
}

// checkoutRemoteMatchesSlug reports whether ANY remote of dir points at
// EXACTLY repoSlug (case-insensitive) — a fork (different owner) never
// matches, by design (see the package doc comment / repos.go).
func checkoutRemoteMatchesSlug(ctx context.Context, dir, repoSlug string) bool {
	out, err := runGitIn(ctx, dir, "remote")
	if err != nil {
		return false
	}
	want := strings.ToLower(strings.Trim(repoSlug, "/"))
	for _, name := range strings.Fields(string(out)) {
		urlOut, err := runGitIn(ctx, dir, "remote", "get-url", name)
		if err != nil {
			continue
		}
		if repoSlugFromRemoteURL(string(urlOut)) == want {
			return true
		}
	}
	return false
}

// repoSlugFromRemoteURL normalizes a GitHub remote URL (https or ssh form)
// down to a lowercase "owner/name", or "" when it isn't recognizably a GitHub
// remote at all.
func repoSlugFromRemoteURL(url string) string {
	url = strings.TrimSpace(url)
	url = strings.TrimSuffix(url, ".git")
	url = strings.TrimSuffix(url, "/")
	if i := strings.Index(url, "github.com:"); i >= 0 {
		return strings.ToLower(strings.Trim(url[i+len("github.com:"):], "/"))
	}
	if i := strings.Index(url, "github.com/"); i >= 0 {
		return strings.ToLower(strings.Trim(url[i+len("github.com/"):], "/"))
	}
	return ""
}

// chatCheckoutRegistryDirs reads the repo's explicit `chatCheckoutDirs` list
// straight from settings.json — deliberately bypassing the process-lifetime
// settings() cache (settings.go), unlike every other repoConfig field: a
// freshly added path must work without a server restart (see the design
// doc's "Live herlezen").
func chatCheckoutRegistryDirs(dataDir, repoSlug string) []string {
	s := loadSettingsFile(filepath.Join(dataDir, "settings.json"))
	want := strings.ToLower(strings.Trim(repoSlug, "/"))
	for _, r := range s.Repos {
		if strings.ToLower(strings.Trim(r.Slug, "/")) == want {
			return r.ChatCheckoutDirs
		}
	}
	return nil
}

// chatCheckoutHomeScanMaxDepth bounds the fallback home-directory scan so it
// can never wander into an unrelated, arbitrarily deep tree.
const chatCheckoutHomeScanMaxDepth = 3

// chatCheckoutHomeScanSkip names directories the scan never even descends
// into — build/dependency trees are never themselves separate git checkouts
// of the reviewed repo, and .git is handled by the "found a checkout, stop
// descending" rule below.
var chatCheckoutHomeScanSkip = map[string]bool{
	"node_modules": true, "vendor": true, ".git": true,
}

// chatCheckoutHomeScan is the ladder's step 2: every git working tree under
// the reviewer's home directory, within a bounded depth, regardless of which
// repo it is — checkoutRemoteMatchesSlug (called by the caller, listCheckoutCandidates)
// is what actually narrows this down to the right repo. Only reached when the
// explicit registry (step 1) yields nothing.
func chatCheckoutHomeScan() []string {
	home := chatCheckoutHomeDir()
	if home == "" {
		return nil
	}
	var out []string
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > chatCheckoutHomeScanMaxDepth {
			return
		}
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			out = append(out, dir)
			return // a repo's own subdirectories are never separate candidates
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") || chatCheckoutHomeScanSkip[name] {
				continue
			}
			if e.Type()&os.ModeSymlink != 0 || !e.IsDir() {
				continue
			}
			walk(filepath.Join(dir, name), depth+1)
		}
	}
	walk(home, 0)
	return out
}

// chatCheckoutHomeDir is the root chatCheckoutHomeScan walks — the reviewer's
// real home directory in production, but overridable via
// SLASH_CHECKOUT_HOME_DIR so a test can point it at an empty/controlled
// throwaway directory instead of the real machine's home (mirrors
// SLASH_REPO_DIR's own test-isolation role for repoDirFor). Without this, any
// test exercising the "no registry configured" fallback path is silently
// coupled to whatever real checkouts happen to exist on whichever machine
// runs it.
func chatCheckoutHomeDir() string {
	if env := strings.TrimSpace(os.Getenv("SLASH_CHECKOUT_HOME_DIR")); env != "" {
		return env
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// checkoutDiscovery is what the ladder SAW while looking for a work
// directory, kept so a dead end can say why instead of always blaming the
// configuration. Reported bug: the write turn's only wording was "add a path
// to `chatCheckoutDirs` in settings.json", which sent the reviewer looking
// for a missing setting on a machine where the right checkout existed and was
// already on the PR's branch — the real cause was a failing `git fetch` (see
// classifyCheckoutCandidate). Every field counts DIRECTORIES OF THIS REPO
// only; a scan full of unrelated checkouts leaves all of them zero.
type checkoutDiscovery struct {
	// Matched: local checkouts whose remote is exactly this repo.
	Matched int
	// Busy: matched checkouts rejected only because they sit on someone
	// else's branch that is not merged into the base branch yet.
	Busy []string
	// Broken: matched checkouts whose classification failed outright.
	Broken []string
	// HeldBack: matched checkouts skipped only because of a HOLDBACK — the
	// reviewer's own earlier "nee, zoek een andere directory", or another PR
	// of the same repo already claiming that directory. Each entry is already
	// annotated with its own reason (annotateCheckoutOption), so the wording
	// below can print it verbatim. This is the case that used to leave every
	// counter at zero and therefore blamed settings.json — see the last-resort
	// pass in prepareChatShellWorkDirAt.
	HeldBack []string
	// Err is the first classification error, verbatim, for the log.
	Err error
}

// reason is the reviewer-facing half of a dead end: one sentence naming what
// was actually in the way, or "" when nothing about this repo was found at
// all (the case the caller's own "configure or clone one" wording is right
// for).
func (d checkoutDiscovery) reason() string {
	switch {
	case len(d.Broken) > 0:
		return fmt.Sprintf("Ik vond %d lokale map(pen) van deze repo (%s), maar kon de git-status er niet van lezen — bijvoorbeeld omdat `git fetch` naar origin niet lukt (geen netwerk, of geen ssh-sleutel geladen).",
			len(d.Broken), strings.Join(d.Broken, ", "))
	case len(d.Busy) > 0:
		return fmt.Sprintf("Ik vond %d lokale map(pen) van deze repo (%s), maar die staan op een andere branch die nog niet is gemerged — die pak ik nooit zomaar af.",
			len(d.Busy), strings.Join(d.Busy, ", "))
	case len(d.HeldBack) > 0:
		return fmt.Sprintf("Ik vond %d lokale map(pen) van deze repo (%s), maar die vielen allemaal weg. Kies er via de werkmap-keuze alsnog een, of voeg een pad toe aan chatCheckoutDirs in settings.json.",
			len(d.HeldBack), strings.Join(d.HeldBack, ", "))
	}
	return ""
}

// ---------------------------------------------------------------------------
// Holdbacks: the two reasons a directory OF THIS REPO, in a perfectly usable
// git state, is still not offered automatically. Both are soft by design —
// see the last-resort pass in prepareChatShellWorkDirAt: with nothing free
// left, the reviewer gets EVERY candidate offered anyway, each labelled with
// the holdback it fell out on, so a PR can never end up with no way forward
// at all (reported bug: "er is wel ruimte in ~/dev", while the write turn
// said there was no local checkout and pointed at settings.json).
// ---------------------------------------------------------------------------

// checkoutHoldback says which directories are held back from an ordinary
// ladder pass, and why. A zero value holds nothing back, which is exactly
// what the last-resort pass (and the explicit "andere directory kiezen"
// menu) uses.
type checkoutHoldback struct {
	// Rejected are the directories the reviewer explicitly said no to for
	// this PR (checkoutStageReuseMerged's "nee" answer, a.Excluded).
	Rejected map[string]bool
	// Claimed maps a directory to the OTHER PR of the same repo currently
	// assigned to it, so two PRs never silently share one folder.
	Claimed map[string]int
}

// holds reports whether dir is held back for either reason.
func (h checkoutHoldback) holds(dir string) bool {
	return h.Rejected[dir] || h.Claimed[dir] != 0
}

// empty reports whether this holdback would skip nothing at all — in which
// case a second, unfiltered pass over the very same directories can only
// return the very same result, so the last-resort choice is pointless.
func (h checkoutHoldback) empty() bool {
	return len(h.Rejected) == 0 && len(h.Claimed) == 0
}

// noteFor is the short, reviewer-facing reason dir was held back, or "" when
// it wasn't. The WORD carries the meaning here (never a colour), same rule as
// everywhere else in this app.
func (h checkoutHoldback) noteFor(dir string) string {
	switch {
	case h.Claimed[dir] != 0:
		return fmt.Sprintf("in gebruik door PR %d", h.Claimed[dir])
	case h.Rejected[dir]:
		return "eerder door jou afgewezen"
	}
	return ""
}

// checkoutOptionNoteSep separates a directory from its holdback note inside
// one chooseDirectory option string — the overlay labels every row with the
// option verbatim (src/workDirOverlay.mjs), so this IS the only place the
// reviewer can see why a directory had fallen out. checkoutOptionDir maps it
// back; no real filesystem path contains an em dash surrounded by spaces.
const checkoutOptionNoteSep = " — "

// annotateCheckoutOption is the option text for one candidate directory:
// bare when nothing was in the way, "<dir> — <reason>" when it was held back.
func annotateCheckoutOption(dir string, hold checkoutHoldback) string {
	if note := hold.noteFor(dir); note != "" {
		return dir + checkoutOptionNoteSep + note
	}
	return dir
}

// checkoutOptionDir recovers the plain directory from an option that may
// carry an annotateCheckoutOption note.
func checkoutOptionDir(opt string) string {
	if i := strings.Index(opt, checkoutOptionNoteSep); i >= 0 {
		return strings.TrimSpace(opt[:i])
	}
	return strings.TrimSpace(opt)
}

// listCheckoutCandidates runs the full discovery ladder (steps 1-2) and
// classifies every directory that survives the "wrong repo" and "someone
// else's unfinished, unmerged branch" filters. hold names the directories
// this pass must skip and why (see checkoutHoldback); a zero holdback skips
// nothing, which is what the last-resort pass and the explicit "andere
// directory kiezen" menu use.
//
// A held-back directory is still CLASSIFIED as "a directory of this repo"
// (diag.Matched/diag.HeldBack) before it is skipped — costing one extra `git
// remote` call per directory — precisely so a dead end can name it instead of
// leaving every counter at zero and blaming settings.json.
func listCheckoutCandidates(ctx context.Context, dataDir, repoSlug, headRef, baseBranch string, hold checkoutHoldback) ([]checkoutCandidate, checkoutDiscovery) {
	seen := map[string]bool{}
	var out []checkoutCandidate
	var diag checkoutDiscovery

	add := func(rawDir string) {
		dir := expandTilde(strings.TrimSpace(rawDir))
		if dir == "" || seen[dir] {
			return
		}
		seen[dir] = true
		if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
			return // not a git working tree at all
		}
		if !checkoutRemoteMatchesSlug(ctx, dir, repoSlug) {
			return // wrong repo, or a fork
		}
		diag.Matched++
		if hold.holds(dir) {
			diag.HeldBack = append(diag.HeldBack, annotateCheckoutOption(dir, hold))
			return
		}
		cand, err := classifyCheckoutCandidate(ctx, dir, headRef, baseBranch)
		if err != nil {
			diag.Broken = append(diag.Broken, dir)
			if diag.Err == nil {
				diag.Err = err
			}
			return
		}
		if !cand.OnTargetBranch && !cand.MergedIntoBase {
			diag.Busy = append(diag.Busy, dir)
			return // someone else's unfinished, unrelated work — never offered
		}
		out = append(out, cand)
	}

	for _, d := range chatCheckoutRegistryDirs(dataDir, repoSlug) {
		add(d)
	}
	if len(out) == 0 {
		for _, d := range chatCheckoutHomeScan() {
			add(d)
		}
	}
	return out, diag
}

// prioritizeOnTargetBranch gives a candidate that already has the PR's OWN
// branch checked out priority over one that is merely on some other,
// already-merged (hence free) branch: reviewer decision ("...-3 is al op die
// branch, gebruik die, de andere staat op master/develop en die mag pas
// meedoen als er niet al een dir is die de branch al heeft"). When at least
// one candidate is OnTargetBranch, every MergedIntoBase-only candidate is
// dropped before selectCheckoutCandidate ever sees the list — so a single
// directory already on the PR branch is auto-picked with no question at all,
// and a reviewer choosing between several only ever compares directories
// that are genuinely already on that branch, never a master/develop checkout
// mixed in. Only when NO candidate is on the target branch do the
// merged-into-base candidates get to participate, exactly as before.
//
// Deliberately NOT folded into listCheckoutCandidates itself: the explicit
// "andere directory kiezen" menu action (listAllCheckoutChoices/
// relistCheckoutCandidates) shows every genuinely eligible candidate on
// purpose, including a merged master/develop checkout even while one is
// already on the branch — the reviewer asking for that menu is explicitly
// choosing to override the automatic pick, so narrowing the list there too
// would take away exactly the choice they asked for. Only the AUTOMATIC first
// pick (selectCheckoutCandidate, used by prepareChatShellWorkDirAt) applies
// this priority.
func prioritizeOnTargetBranch(candidates []checkoutCandidate) []checkoutCandidate {
	var onTarget []checkoutCandidate
	for _, c := range candidates {
		if c.OnTargetBranch {
			onTarget = append(onTarget, c)
		}
	}
	if len(onTarget) > 0 {
		return onTarget
	}
	return candidates
}

// selectCheckoutCandidate is the ladder's pure decision step, given already-
// classified candidates: no candidates -> nothing at all; more than one ->
// the reviewer always chooses (chooseDirectory); exactly one -> auto-picked
// (its own dirty/reuse state is resolved by the caller once it becomes the
// PR's assignment). candidates is narrowed via prioritizeOnTargetBranch
// FIRST, so "more than one" only ever means more than one candidate at the
// same priority tier. Kept as a standalone, dependency-free function so it
// can be unit-tested without any real git repo.
func selectCheckoutCandidate(candidates []checkoutCandidate) (dir string, decision *chatCheckoutDecision) {
	candidates = prioritizeOnTargetBranch(candidates)
	if len(candidates) == 0 {
		return "", nil
	}
	if len(candidates) == 1 {
		return candidates[0].Dir, nil
	}
	opts := make([]string, 0, len(candidates))
	for _, c := range candidates {
		opts = append(opts, c.Dir)
	}
	return "", &chatCheckoutDecision{
		Stage:   checkoutStageChooseDirectory,
		Body:    "Er zijn meerdere lokale directories geschikt voor deze PR. Welke wil je gebruiken?",
		Options: opts,
	}
}

// checkoutLastResortDecision is the ladder's step 3, and the ONE place a
// held-back directory is ever offered: no directory is free any more, so the
// reviewer chooses between ALL of them — a directory another PR claims, and a
// directory they themselves rejected earlier, each labelled with exactly that
// reason (annotateCheckoutOption; the word carries the meaning, there is no
// colour involved). Deliberately never auto-picked, not even with a single
// option left: overruling one's own "nee" or taking a folder off another PR is
// a decision, never a guess.
//
// prioritizeOnTargetBranch is deliberately NOT applied — same reasoning as
// listAllCheckoutChoices: this list exists so the reviewer can see and pick
// everything there is.
//
// optNoneOfThese keeps the choice answerable in the one direction that would
// otherwise be a trap: a reviewer who wants none of these gets the honest
// dead-end wording (checkoutDiscovery.reason) instead of a question that
// cannot be dismissed. A LATER request runs the ladder again and may ask
// again — that is a new request, not the same unanswerable loop the removed
// checkoutStageDivergedHistory consult used to produce.
func checkoutLastResortDecision(candidates []checkoutCandidate, hold checkoutHoldback) *chatCheckoutDecision {
	opts := make([]string, 0, len(candidates)+1)
	for _, c := range candidates {
		opts = append(opts, annotateCheckoutOption(c.Dir, hold))
	}
	opts = append(opts, optNoneOfThese)
	return &chatCheckoutDecision{
		Stage:   checkoutStageChooseDirectory,
		Body:    "Er is geen vrije werkmap meer voor deze PR. Dit zijn alle lokale directories van deze repo die ik alsnog kan gebruiken, met per map waarom hij eerst afviel. Welke mag ik gebruiken?",
		Options: opts,
	}
}

// ---------------------------------------------------------------------------
// The reviewer consult: forceful, structured, answered via the SAME
// message/Signal round trip a chat.KindQuestion already uses (see
// modules/chat.KindDirectoryDecision's own doc comment for why no new
// workflow shape was needed).
// ---------------------------------------------------------------------------

// chatCheckoutDecision is one pending question about the checkout itself
// (never about the reviewer's actual review content) — which directory to
// use, whether to reuse a freed one, or what to do with pre-existing, unrelated
// changes. Stage says which step of the ladder it belongs to, so the reply is
// interpreted correctly regardless of how the reviewer phrases it. Matching
// (matchCheckoutOption below) is trimmed and case-insensitive, but otherwise
// still requires one of Options verbatim — free text that doesn't match any
// of them resolves nothing and the SAME decision is asked again, now prefixed
// with an explicit "I didn't recognize that answer" note (see
// applyCheckoutDecisionReply's caller in chat_workflow.go) instead of a silent,
// unexplained repeat.
type chatCheckoutDecision struct {
	Stage   string   `json:"stage"`
	Dir     string   `json:"dir,omitempty"` // the candidate this decision is about (all stages but chooseDirectory)
	Body    string   `json:"body"`
	Options []string `json:"options,omitempty"`
	// Paths are the repo-relative files the choice is ABOUT — currently only
	// checkoutStageDirtyTree, where they are the already-changed, uncommitted
	// files sitting in the work directory (checkoutCandidate.DirtyPaths, from
	// the same `git status --porcelain` call that set Dirty, so this costs no
	// extra git invocation). Purely informational: the werkmap overlay
	// (src/workDirOverlay.mjs) lists them so the reviewer can SEE what
	// "Verwijderen"/"Meenemen in de commit"/… is about to act on. Reported
	// bug: a reviewer answered "Meenemen in de commit" for changes he could
	// not see and only found out afterwards which files had been swept along.
	// Never part of the answer matching (matchCheckoutOption reads Options
	// only) and never part of the overlay's own choiceFingerprint, so a path
	// list that shifts between two refetches of the SAME choice does not
	// re-open a dismissed overlay.
	Paths []string `json:"paths,omitempty"`
}

const (
	checkoutStageChooseDirectory = "chooseDirectory"
	checkoutStageReuseMerged     = "reuseMerged"
	checkoutStageDirtyTree       = "dirtyTree"
	// checkoutStageLandingFailed is a PURELY INFORMATIONAL decision — no
	// Options at all — raised by markCheckoutLandingFailedAt (chat_merge.go's
	// processChatMergeAt) when a landing attempt failed for a reason that
	// will NOT otherwise surface as one of the two stages above on the next
	// write attempt (the checkout isn't left dirty, or the reviewer already
	// accepted that dirt earlier). Without it, that failure was only a chat
	// bubble in whichever conversation triggered it — reviewer request: "laat
	// de error duidelijk zien als een overlay, niet alleen een bubbel die je
	// kunt missen". Reuses the existing werkmap overlay (src/workDirOverlay.mjs)
	// unchanged: its row list already falls back to "Andere werkmap kiezen"/
	// "Uit"/"Chat pauzeren" for a decision with no Options, so this needs no
	// new frontend code at all.
	checkoutStageLandingFailed = "landingFailed"
)

const (
	optDiscard      = "Verwijderen"
	optStashManual  = "Stash (ik zet het later zelf terug)"
	optStashAuto    = "Stash (automatisch terugzetten zodra dit gesprek de directory weer vrijgeeft)"
	optKeepSeparate = "Los laten (buiten Claude's commit houden)"
	optKeepCombined = "Meenemen in de commit"
	optReuseYes     = "Ja, gebruik deze directory voor deze PR"
	optReuseNo      = "Nee, zoek een andere directory"
	// optNoneOfThese is only ever offered by checkoutLastResortDecision — the
	// way out of a choice between directories that all have something against
	// them.
	optNoneOfThese = "Geen van deze"
)

// checkoutOptionAliases are natural-language stand-ins for an option's own
// (deliberately explicit, full-sentence) canonical text, consulted by
// matchCheckoutOption ONLY when no option matched byte-exactly. Reported bug:
// a reviewer who types "gewoon ernaast doen" instead of clicking the
// "Los laten (buiten Claude's commit houden)" button got "Dat antwoord
// herkende ik niet als een van de keuzes" forever — an unanswerable,
// ever-repeating question, exactly the failure mode chatCheckoutDirtyDecision's
// own doc comment already calls out for a DIFFERENT stage (the removed
// checkoutStageDivergedHistory). Kept small and specific on purpose: each
// alias is a distinctive word/phrase that only ever means ONE of the offered
// options, never a generic word that could plausibly mean several (a wrong
// match here would silently do the wrong git operation).
var checkoutOptionAliases = map[string][]string{
	optKeepSeparate: {"ernaast", "naast elkaar", "los laten", "apart houden", "laat maar staan"},
}

// matchCheckoutReplyAlias reports whether reply's own words contain one of
// opt's aliases — a plain substring check on the lowercased, trimmed reply,
// which is enough for the short, distinctive phrases above.
func matchCheckoutReplyAlias(opt, lowerReply string) bool {
	for _, alias := range checkoutOptionAliases[opt] {
		if strings.Contains(lowerReply, alias) {
			return true
		}
	}
	return false
}

// chatCheckoutDirtyDecision builds the consult for a candidate with genuinely
// dirty (uncommitted) changes — the only case left that still needs a
// reviewer decision before Claude may touch this directory. A candidate that
// is merely clean-but-not-fast-forwardable (real local commits origin
// doesn't have yet) is no longer asked about at all: Claude only ever COMMITS
// on top, never discards or force-overwrites anything, so there is nothing to
// protect against — see prepareChatShellWorkDirAt's own handling of that case
// (reviewer decision: "je mag hier gewoon op verder bouwen"). This also
// removes the one consult (formerly checkoutStageDivergedHistory, a single
// "Doorgaan met de huidige lokale stand" option) whose free-text answer could
// never resolve it byte-exactly, producing an unanswerable, ever-repeating
// question — see matchCheckoutOption below for the belt-and-braces fix to the
// matching itself, kept for the stages that remain.
func chatCheckoutDirtyDecision(c checkoutCandidate) *chatCheckoutDecision {
	return &chatCheckoutDecision{
		Stage: checkoutStageDirtyTree, Dir: c.Dir,
		Body:    fmt.Sprintf("`%s` heeft nog niet-gerelateerde, niet-gecommitte wijzigingen. Wat moet daarmee gebeuren voordat ik hier iets aanpas?", c.Dir),
		Options: []string{optDiscard, optStashManual, optStashAuto, optKeepSeparate, optKeepCombined},
		Paths:   c.DirtyPaths,
	}
}

// chatCheckoutReuseDecision is the "this directory is currently on a
// different, already-merged (hence free) branch — mag ik die overnemen?"
// consult, always shown before switching, even when the directory is clean.
func chatCheckoutReuseDecision(c checkoutCandidate, headRef string) *chatCheckoutDecision {
	return &chatCheckoutDecision{
		Stage: checkoutStageReuseMerged, Dir: c.Dir,
		Body:    fmt.Sprintf("`%s` staat nu op `%s`, dat al is gemerged — dus vrij. Gebruiken voor deze PR (branch `%s`)?", c.Dir, c.Branch, headRef),
		Options: []string{optReuseYes, optReuseNo},
	}
}

// markCheckoutLandingFailedAt raises a checkoutStageLandingFailed notice for
// (repo, pr) — called by chat_merge.go's processChatMergeAt right after a
// landing attempt errored. Deliberately a no-op when the checkout is left in
// an ORDINARY dirty state that will already ask its own checkoutStageDirtyTree
// question on the very next write attempt (dirtyIsOnlyPendingEdits no longer
// hides it there, see processChatMergeAt's own doc comment) — this notice
// exists only for the failures that would otherwise leave NOTHING for the
// reviewer to see beyond a chat bubble in whichever conversation triggered
// it: the checkout's own working tree came back clean (a push-target/ref
// failure, e.g. advancePendingRefFromCheckout), the dirt was already accepted
// earlier ("Meenemen in de commit"/"Los laten"), or the reclassification
// itself errored (best-effort: treated the same as "won't self-explain").
// dataDir/headRef/body are exactly what processChatMergeAt already has to
// hand: the failing chat.Message's own Body becomes this decision's Body, so
// the overlay shows the SAME real reason the conversation's own bubble does.
func markCheckoutLandingFailedAt(ctx context.Context, dataDir, repo string, pr int, headRef, body string) {
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil || a.Dir == "" {
		return
	}
	cand, err := classifyCheckoutCandidate(ctx, a.Dir, headRef, baseBranchFor(repo))
	if err == nil && cand.Dirty && !dirtyAlreadyAccepted(ctx, a) && !dirtyIsOnlyPendingEdits(cand.DirtyPaths, repo, pr) {
		return
	}
	a.Pending = &chatCheckoutDecision{Stage: checkoutStageLandingFailed, Dir: a.Dir, Body: body}
}

// ---------------------------------------------------------------------------
// The PR-scoped assignment: which checkout this PR is using, and what has
// already been decided about it. The durable truth is always git itself
// (which directory is on which branch, in what state), so losing any of this
// only costs re-running the ladder once — the same operational carve-out as
// pendingPushStatus (see .claude/rules/workflows-write-boundary.md).
//
// Dir/Branch specifically are ALSO mirrored into a tiny durable SQLite table
// (chat_checkout_store.go) — everything else on this struct (Pending,
// Excluded, the dirty/stash bookkeeping) stays in-memory only, gone after a
// restart. Without that mirror, a restart made buildCheckoutView (the read
// behind the checkout chip) forget which directory a PR was using, even
// though the git checkout — commit and all — was still sitting right there
// on disk: reported bug, "Geen werkmap" next to a chat that already showed
// landed edits. See "Durable checkout dir/branch" in
// .claude/docs/pending-push.md.
// ---------------------------------------------------------------------------

type chatCheckoutAssignment struct {
	Dir string
	// Branch is the assigned candidate's own branch at the moment it became
	// ready (mirrors checkoutCandidate.Branch) — cached here purely for the
	// read-only checkout view (buildCheckoutView) below, which must never
	// itself shell out to git.
	Branch string
	// Pending is the ONE open work-directory choice of this PR, owned by
	// nobody: it is a PR-wide setting, not a question inside some
	// conversation, so it is raised/answered through the work-directory
	// overlay's own read model (buildCheckoutView -> GET /api/chat/checkout)
	// and the "checkoutAnswer" Action. It used to carry a
	// PendingConversationID and be answerable only by the chat turn that
	// raised it; see "The work-directory choice left the chat" in
	// .claude/docs/workflows-comments.md for why that is gone.
	Pending *chatCheckoutDecision
	// Excluded is every directory the reviewer explicitly rejected via
	// checkoutStageReuseMerged's "no" answer, for this PR's lifetime. A
	// reviewer-triggered relist (relistCheckoutCandidates) always clears this
	// — an explicit "andere directory kiezen" is a clean slate, not bound by
	// an earlier rejection.
	Excluded map[string]bool
	// KeepSeparatePaths are the paths the reviewer chose to keep OUT of
	// Claude's own commit ("Los laten") — recorded once, at the moment the
	// dirty-tree decision was resolved, and consumed by commitCheckoutEditsAt.
	KeepSeparatePaths []string
	// DirtyAcceptedDir/DirtyAcceptedPaths record a resolved dirty-tree choice
	// that deliberately LEFT the working tree dirty ("Los laten"/"Meenemen in
	// de commit"): which directory it was about, and exactly which paths were
	// dirty at that moment. Without it every LATER write turn re-classified
	// the same still-dirty directory and raised the identical dirtyTree
	// question again — reported bug: answering "Meenemen in de commit" and
	// then asking Claude for a change kept coming back as "er staat nog een
	// keuze open over de werkmap van deze PR", forever (chatCheckoutResolved's
	// Final only skips re-classification WITHIN the call that resolved it).
	// Deliberately separate from KeepSeparatePaths above, which
	// commitCheckoutEditsAt clears after a landing — those paths are still
	// dirty afterwards and must not start asking again.
	DirtyAcceptedDir   string
	DirtyAcceptedPaths []string
	// StashRef/StashDir/StashAutoRestore record a stash this resolution
	// created (StashDir is the directory it was taken FROM — kept separately
	// from Dir since "uit"/checkoutSetOff clears Dir but must never strand an
	// unrestored stash with no known location), and whether it should be
	// popped automatically the next time this PR's checkout lands a commit
	// (see commitCheckoutEditsAt) — or on demand, via checkoutRestoreStashNow.
	StashRef         string
	StashDir         string
	StashAutoRestore bool
	// LastReason is the last dead end's own explanation (checkoutDiscovery.
	// reason()), so the write turn can tell the reviewer what was actually in
	// the way instead of always pointing at settings.json. Empty means "no
	// checkout of this repo found at all", which IS the configuration case.
	LastReason string
	// LastReasonTransient marks LastReason as something that resolves BY
	// ITSELF, with no reviewer action needed — currently only the "another
	// conversation's edits are still landing" case below. runOneClaudeTurn
	// (chat_workflow.go) uses this to automatically wait+retry instead of
	// dead-ending in a terminal message the reviewer would have to notice and
	// retype. Every other LastReason assignment in this file explicitly resets
	// this to false, so a stale true can never leak onto an unrelated reason.
	LastReasonTransient bool
}

var (
	chatCheckoutMu   sync.Mutex
	chatCheckoutByPR = map[prKey]*chatCheckoutAssignment{}
)

// getOrCreateCheckoutAssignment returns this PR's in-memory assignment,
// creating it on first touch. A fresh one is seeded from the durable
// dir/branch persisted in chat_checkout_store.go (a process restart clears
// chatCheckoutByPR, not that table) — the selection ladder's own
// re-classification (prepareChatShellWorkDirAt's `a.Dir != ""` branch) then
// verifies it is still usable before anything relies on it, exactly as it
// already does for a dir that survived within the same process.
func getOrCreateCheckoutAssignment(dataDir, repo string, pr int) *chatCheckoutAssignment {
	key := prKey{Repo: repo, PR: pr}
	chatCheckoutMu.Lock()
	defer chatCheckoutMu.Unlock()
	a := chatCheckoutByPR[key]
	if a == nil {
		a = &chatCheckoutAssignment{Excluded: map[string]bool{}}
		if dir, branch, ok := loadPersistedCheckout(dataDir, repo, pr); ok {
			a.Dir, a.Branch = dir, branch
		}
		chatCheckoutByPR[key] = a
	}
	return a
}

// getCheckoutAssignment is the read-only lookup — nil when this PR has never
// resolved a checkout at all, neither in this process nor durably (never
// creates a genuinely empty entry, unlike the function above). Same durable
// seed-on-first-touch as getOrCreateCheckoutAssignment, so a read (e.g.
// buildCheckoutView, behind the checkout chip) reflects a PR's last known
// checkout immediately after a restart, without waiting for a write turn to
// re-touch it first.
func getCheckoutAssignment(dataDir, repo string, pr int) *chatCheckoutAssignment {
	key := prKey{Repo: repo, PR: pr}
	chatCheckoutMu.Lock()
	defer chatCheckoutMu.Unlock()
	a := chatCheckoutByPR[key]
	if a != nil {
		return a
	}
	if dir, branch, ok := loadPersistedCheckout(dataDir, repo, pr); ok {
		a = &chatCheckoutAssignment{Excluded: map[string]bool{}, Dir: dir, Branch: branch}
		chatCheckoutByPR[key] = a
	}
	return a
}

// checkoutWriteSlotKey is the key acquireWriteTurnSlot (chat_write_gate.go)
// serializes on for one PR's checkout-mutating operations (a write turn's
// Edit/Bash phase, its automatic landing, and the werkmap-overlay's own
// answer/relist/restore-stash actions).
//
// Once this PR has a directory assigned, the key is that DIRECTORY itself
// (its absolute path) rather than the PR number — deliberately, per the
// reviewer's own requirement: two PRs that end up sharing one physical
// checkout (a directory another PR already claims, offered again via the
// "andere werkmap kiezen" last-resort choice) must still serialize against
// each other, not just against their own PR number. Before a directory is
// assigned yet (first resolution for this PR), nothing else can collide with
// this PR's own still-unknown directory, so a plain per-PR key is exactly as
// safe and doesn't need a placeholder.
func checkoutWriteSlotKey(dataDir, repo string, pr int) string {
	if a := getCheckoutAssignment(dataDir, repo, pr); a != nil && a.Dir != "" {
		return "dir:" + a.Dir
	}
	return fmt.Sprintf("pr:%s:%d", repo, pr)
}

// persistCheckoutAssignment durably mirrors a's current Dir/Branch for
// repo/pr (see chat_checkout_store.go for why this is a direct write rather
// than a workflow one). Called after every point that can change a.Dir:
// deferred once in prepareChatShellWorkDirAt (so every return path, however
// many loop iterations it took, persists the FINAL state) and directly in
// relistCheckoutCandidates/checkoutSetOff, which don't loop.
func persistCheckoutAssignment(dataDir, repo string, pr int, a *chatCheckoutAssignment) {
	savePersistedCheckout(dataDir, repo, pr, a.Dir, a.Branch)
}

// checkoutDirClaimsByOtherPRs maps every directory currently assigned (in
// this very process) to some OTHER PR of the same repo onto that PR's own
// number — so the ladder never hands the same local checkout to two PRs at
// once, and so the reviewer can SEE which PR is holding a directory when it
// is offered to them anyway (annotateCheckoutOption). Without the claim at
// all, listCheckoutCandidates only ever skipped a directory the reviewer had
// explicitly rejected (a.Excluded), never one another PR's own assignment
// already claims; the reported bug was two different open PRs both showing
// the same "plug-and-pay-2" folder pill on /pr-overview, because the second
// PR's ladder run auto-picked (or was offered, via "andere directory
// kiezen") a directory the first PR was already using — leaving the first
// PR's own stored assignment silently stale until its next write turn
// happens to re-classify it (prepareChatShellWorkDirAt's `a.Dir != ""`
// branch). A claim taken over deliberately is released right away, see
// releaseCheckoutDirFromOtherPRs.
func checkoutDirClaimsByOtherPRs(repo string, pr int) map[string]int {
	chatCheckoutMu.Lock()
	defer chatCheckoutMu.Unlock()
	claims := map[string]int{}
	for key, a := range chatCheckoutByPR {
		if key.Repo != repo || key.PR == pr || a == nil || a.Dir == "" {
			continue
		}
		claims[a.Dir] = key.PR
	}
	return claims
}

// checkoutHoldbackFor is the holdback of one ordinary ladder pass: the PR's
// own explicit rejections plus every directory another PR claims. rejected is
// the PR's own persisted Excluded map and is used AS IS (never mutated, never
// unioned into) so it keeps meaning exactly "the reviewer said no to this
// one" and can be reported separately from a claim.
func checkoutHoldbackFor(repo string, pr int, rejected map[string]bool) checkoutHoldback {
	return checkoutHoldback{Rejected: rejected, Claimed: checkoutDirClaimsByOtherPRs(repo, pr)}
}

// releaseCheckoutDirFromOtherPRs drops dir from every OTHER PR of the same
// repo that still claims it — called the moment this PR really takes a
// directory, so the "two PRs showing the same folder pill" bug can never come
// back through the last-resort choice (which deliberately offers a claimed
// directory). Only in-memory assignments are found; a claim that lives only
// in the durable store heals itself on its own next touch, because that PR's
// re-classification then finds the directory on somebody else's branch and
// re-runs the ladder (prepareChatShellWorkDirAt's `a.Dir != ""` branch).
func releaseCheckoutDirFromOtherPRs(dataDir, repo string, pr int, dir string) {
	if dir == "" {
		return
	}
	var released []int
	chatCheckoutMu.Lock()
	for key, a := range chatCheckoutByPR {
		if key.Repo != repo || key.PR == pr || a == nil || a.Dir != dir {
			continue
		}
		a.Dir = ""
		a.Branch = ""
		released = append(released, key.PR)
	}
	chatCheckoutMu.Unlock()
	// Outside the lock: savePersistedCheckout takes its own.
	for _, other := range released {
		savePersistedCheckout(dataDir, repo, other, "", "")
	}
}

// checkoutChoiceOpen reports whether this PR has an unresolved work-directory
// choice at all, regardless of who raised it. It is how a caller of
// prepareChatShellWorkDir tells the ownership guard's "not now" apart from a
// genuine "there is no usable directory": both come back as (nil, false), but
// only the first is something the reviewer can act on. Deliberately a plain
// read of the same in-memory assignment (no signature change on the three
// callers), mirroring hasPendingCheckoutDecision right above it.
func checkoutChoiceOpen(dataDir, repo string, pr int) bool {
	a := getCheckoutAssignment(dataDir, repo, pr)
	return a != nil && a.Pending != nil
}

// checkoutPendingStillNeeded re-derives whether this PR's one open
// work-directory choice is still a REAL question, right now. A choice is
// raised once, from whatever the checkout looked like at that moment, and
// then simply sits there until somebody answers it verbatim — so a reviewer
// who resolves the situation OUTSIDE slash (the reported case: "geef die
// keuze opnieuw als het nodig is, want alles is al gecommit") stayed blocked
// on a question about changes that no longer existed, with every write turn
// answering "er staat nog een keuze open over de werkmap van deze PR".
//
// Only the two stages that are ABOUT a specific directory's state can go
// stale this way:
//
//   - dirtyTree: pointless once that directory is clean again (or once the
//     reviewer already accepted the dirt, same test the raising site uses).
//   - reuseMerged: pointless once that directory is on the PR's own branch —
//     there is nothing left to "take over".
//
// chooseDirectory (several eligible candidates) deliberately stays: it does
// not go stale from committing, and the ladder would only ask the identical
// thing again one iteration later.
//
// A directory that can no longer be classified at all (gone, unreadable) also
// counts as "not needed": dropping the choice lets the ladder run again and
// find another candidate, mirroring what prepareChatShellWorkDirAt's own
// `a.Dir != ""` branch already does with a classification error.
//
// repo/pr are only used for the dirtyTree stage's own
// dirtyIsOnlyPendingEdits check: a dirty tree that turns out to be entirely
// another conversation's not-yet-landed edit is also "not needed" — the
// question was never a real one for the reviewer to begin with.
func checkoutPendingStillNeeded(ctx context.Context, a *chatCheckoutAssignment, repo string, pr int, headRef, baseBranch string) bool {
	if a == nil || a.Pending == nil {
		return false
	}
	switch a.Pending.Stage {
	case checkoutStageDirtyTree, checkoutStageReuseMerged:
	case checkoutStageLandingFailed:
		// Purely informational (see its own doc comment): once a NEW write
		// turn actually starts running this ladder, that attempt's own
		// outcome — success or its own fresh message — already supersedes a
		// notice about the PREVIOUS attempt, so it is never needed by the
		// time this is asked.
		return false
	default:
		return true
	}
	if a.Pending.Dir == "" {
		return true
	}
	cand, err := classifyCheckoutCandidate(ctx, a.Pending.Dir, headRef, baseBranch)
	if err != nil {
		return false
	}
	if a.Pending.Stage == checkoutStageDirtyTree {
		return cand.Dirty && !dirtyAlreadyAccepted(ctx, a) && !dirtyIsOnlyPendingEdits(cand.DirtyPaths, repo, pr)
	}
	return !cand.OnTargetBranch
}

// checkoutFailureReason is the reviewer-facing explanation of this PR's last
// failed work-directory resolution, or "" when there simply is no local
// checkout of this repo (or none has been attempted). Same plain in-memory
// read as checkoutChoiceOpen right above it, for the same reason: it keeps
// the three callers of prepareChatShellWorkDir on their existing signature.
//
// transient reports whether that reason resolves BY ITSELF (currently only
// "another conversation's edits are still landing") — runOneClaudeTurn
// (chat_workflow.go) uses it to wait+retry automatically instead of
// dead-ending in a message the reviewer would have to notice and retype.
func checkoutFailureReason(dataDir, repo string, pr int) (reason string, transient bool) {
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil {
		return "", false
	}
	return a.LastReason, a.LastReasonTransient
}

// ---------------------------------------------------------------------------
// Git housekeeping the reviewer's decision drives.
//
// Every command below that can touch the WORKING TREE (checkout/reset/clean/
// merge — never a bare `fetch`/`status`) carries `-c submodule.recurse=false`,
// and every `status` call carries `--ignore-submodules=all` — the exact fix
// for a real production incident (see "Incident: a wedged shadow worktree
// degraded every turn to tool-less, silently" in
// .claude/docs/workflows-comments.md): the reviewed repo carries real, active
// submodules and a plain `git reset`/`checkout`/`merge` can try to
// (re)initialize one, fail partway (no credentials/network for a nested
// clone from this subprocess), and leave a permanently wedged, half-
// initialized gitdir behind. Claude never touches a submodule's own content,
// so there is nothing lost by disabling this per-invocation rather than
// writing to the checkout's own `.gitconfig`.
// ---------------------------------------------------------------------------

func discardCheckoutDirty(ctx context.Context, dir string) error {
	if _, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "checkout", "--", "."); err != nil {
		return err
	}
	_, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "clean", "-fd")
	return err
}

func stashCheckoutDirty(ctx context.Context, dir, label string) error {
	_, err := runGitIn(ctx, dir, "stash", "push", "-u", "-m", label)
	return err
}

func popCheckoutStash(ctx context.Context, dir, label string) error {
	out, err := runGitIn(ctx, dir, "stash", "list")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, label) {
			ref := strings.SplitN(line, ":", 2)[0]
			_, err := runGitIn(ctx, dir, "stash", "pop", strings.TrimSpace(ref))
			return err
		}
	}
	return fmt.Errorf("stash labelled %q not found", label)
}

// snapshotDirtyPaths lists the paths `git status --porcelain` currently
// reports, for the "Los laten" choice: these are excluded from Claude's own
// commit later (commitCheckoutEditsAt), regardless of what Claude itself
// stages, so a pre-existing, unrelated change never rides along silently.
func snapshotDirtyPaths(ctx context.Context, dir string) ([]string, error) {
	out, err := runGitIn(ctx, dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return nil, err
	}
	return parseGitStatusPaths(out), nil
}

// parseGitStatusPaths is `git status --porcelain`'s own output parsed into
// plain repo-relative paths — factored out of snapshotDirtyPaths so
// classifyCheckoutCandidate can populate checkoutCandidate.DirtyPaths from
// the SAME status call it already makes for Dirty, with no second `git`
// invocation.
func parseGitStatusPaths(out []byte) []string {
	var paths []string
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if len(line) < 4 {
			continue
		}
		p := strings.TrimSpace(line[3:])
		if i := strings.Index(p, " -> "); i >= 0 { // a rename's "old -> new"
			p = p[i+4:]
		}
		p = strings.Trim(p, `"`)
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths
}

// checkoutOntoBranch switches dir onto the PR's own branch. Like
// classifyCheckoutCandidate, an unreachable origin only costs freshness: as
// long as this checkout already has a refs/remotes/origin/<headRef> on disk,
// the branch can be created from it and a later landing/push reconciles the
// rest. Only a failed fetch AND no local ref at all is a genuine dead end,
// and then the fetch error is the useful one to report.
func checkoutOntoBranch(ctx context.Context, dir, headRef string) error {
	if err := fetchOriginBranch(ctx, dir, headRef); err != nil && !originRefExists(ctx, dir, headRef) {
		return err
	}
	_, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "checkout", "-B", headRef, "origin/"+headRef)
	return err
}

func fastForwardCheckoutToOrigin(ctx context.Context, dir, headRef string) error {
	if err := fetchOriginBranch(ctx, dir, headRef); err != nil && !originRefExists(ctx, dir, headRef) {
		return err
	}
	_, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "merge", "--ff-only", "origin/"+headRef)
	return err
}

// applyCheckoutDecisionReply performs the git housekeeping a resolved
// decision implies. A nil, nil return means reply matched none of the
// offered options (ask again, unchanged); a non-nil resolved.Dir ("" allowed
// — see checkoutStageReuseMerged's "no") means the decision is settled.
//
// Final marks a resolution that must be accepted AS-IS, skipping the caller's
// usual re-classification of the (now-assigned) candidate: "los laten"/
// "meenemen" and "doorgaan met lokale stand" deliberately do NOT clean the
// working tree/history at all, so re-checking dirty/fast-forwardable state
// right after would just trigger the exact same decision again, forever.
// Every other resolution (discard, stash, a completed branch switch) DOES
// leave the candidate in a genuinely different state, so re-classifying it
// is exactly what picks up e.g. a needed fast-forward afterwards.
type chatCheckoutResolved struct {
	Dir   string
	Final bool
}

// matchCheckoutOption resolves reply against options the same forgiving way
// for every stage: trimmed and case-insensitive, so a stray leading/trailing
// space or a different letter case is not treated as "the reviewer typed
// something else". Falling back to checkoutOptionAliases (see its own doc
// comment) also recognizes a short natural-language stand-in for one of the
// OFFERED options — an actual mismatch (free text that matches none of the
// offered choices, verbatim or via an alias) still resolves nothing. Returns
// the OPTION's own canonical text (never the reply's original
// casing/whitespace) so every switch below can keep comparing against the
// exported opt* constants.
func matchCheckoutOption(options []string, reply string) (string, bool) {
	reply = strings.TrimSpace(reply)
	for _, opt := range options {
		if strings.EqualFold(strings.TrimSpace(opt), reply) {
			return opt, true
		}
	}
	lowerReply := strings.ToLower(reply)
	for _, opt := range options {
		if matchCheckoutReplyAlias(opt, lowerReply) {
			return opt, true
		}
	}
	return "", false
}

// acceptDirty/clearDirtyAccepted/dirtyAlreadyAccepted are the three halves of
// "the reviewer already said what should happen with the changes sitting in
// this work directory". See DirtyAcceptedDir's own doc comment for the bug
// they fix.
func (a *chatCheckoutAssignment) acceptDirty(dir string, paths []string) {
	a.DirtyAcceptedDir = dir
	a.DirtyAcceptedPaths = paths
}

func (a *chatCheckoutAssignment) clearDirtyAccepted() {
	a.DirtyAcceptedDir = ""
	a.DirtyAcceptedPaths = nil
}

// dirtyAlreadyAccepted reports whether every path git currently reports dirty
// in a.Dir was already covered by the reviewer's own earlier "leave it"
// choice for that SAME directory. Deliberately a subset check rather than an
// equality one: work that was accepted and has since been committed/reverted
// simply disappears from the list (still accepted), while genuinely NEW,
// never-discussed changes make the question come back. An unreadable status
// answers false — asking again is the conservative side, matching every other
// degrade path in this file.
func dirtyAlreadyAccepted(ctx context.Context, a *chatCheckoutAssignment) bool {
	if a.DirtyAcceptedDir == "" || a.DirtyAcceptedDir != a.Dir {
		return false
	}
	current, err := snapshotDirtyPaths(ctx, a.Dir)
	if err != nil {
		return false
	}
	accepted := make(map[string]bool, len(a.DirtyAcceptedPaths))
	for _, p := range a.DirtyAcceptedPaths {
		accepted[p] = true
	}
	for _, p := range current {
		if !accepted[p] {
			return false
		}
	}
	return true
}

// dirtyIsOnlyPendingEdits reports whether EVERY one of paths is already a
// known, not-yet-landed edit this PR's checkout is holding
// (chatPendingEditedFilesFor, chat_edit_pending.go) — i.e. this "dirty tree"
// isn't the reviewer's own unrelated work at all, it's a DIFFERENT
// conversation's turn whose edit simply hasn't reached its own landing step
// yet (the write-turn slot is released before the automatic post-turn land,
// see chat_write_gate.go/chat_workflow.go). Asking the reviewer what to do
// with it would be asking them to discard/stash another conversation's own
// in-flight Claude edit — reported bug: two chats on the same PR, one
// escalating to write while the other's edit was still landing, kept
// re-raising "er zijn niet-gerelateerde wijzigingen" forever. An empty paths
// list (or no pending edits recorded at all) answers false — callers only
// reach here once cand.Dirty is already true.
func dirtyIsOnlyPendingEdits(paths []string, repo string, pr int) bool {
	if len(paths) == 0 {
		return false
	}
	// A landing has to actually still be coming for this to be a transient,
	// self-resolving wait — see chatLandExpected (chat_edit_pending.go). A
	// cancelled or failed turn's leftovers are marked pending just the same
	// (finishChatProgress does not care how the turn ended), but nothing will
	// ever land them, so treating those as "still landing" made every later
	// write turn of that PR wait for something that could not happen.
	if !chatLandExpected(repo, pr) {
		return false
	}
	pending := chatPendingEditedFilesFor(repo, pr)
	if len(pending) == 0 {
		return false
	}
	known := make(map[string]bool, len(pending))
	for _, p := range pending {
		known[p] = true
	}
	for _, p := range paths {
		if !known[p] {
			return false
		}
	}
	return true
}

func applyCheckoutDecisionReply(ctx context.Context, a *chatCheckoutAssignment, repo string, pr int, headRef, reply string) (*chatCheckoutResolved, error) {
	d := a.Pending
	switch d.Stage {
	case checkoutStageChooseDirectory:
		opt, ok := matchCheckoutOption(d.Options, reply)
		if !ok {
			return nil, nil
		}
		if opt == optNoneOfThese {
			// Final with no directory: the turn dead-ends with the reason the
			// ladder already recorded, instead of asking the same thing again
			// one loop iteration later. See checkoutLastResortDecision.
			return &chatCheckoutResolved{Dir: "", Final: true}, nil
		}
		dir := checkoutOptionDir(opt)
		// A directory the reviewer picks HERE is picked deliberately, so an
		// earlier "nee, zoek een andere directory" about that same directory
		// must not immediately veto it again on the next ladder pass.
		delete(a.Excluded, dir)
		return &chatCheckoutResolved{Dir: dir}, nil
	case checkoutStageReuseMerged:
		opt, ok := matchCheckoutOption(d.Options, reply)
		if !ok {
			return nil, nil
		}
		switch opt {
		case optReuseYes:
			if err := checkoutOntoBranch(ctx, d.Dir, headRef); err != nil {
				return nil, err
			}
			return &chatCheckoutResolved{Dir: d.Dir}, nil
		case optReuseNo:
			a.Excluded[d.Dir] = true
			return &chatCheckoutResolved{Dir: ""}, nil
		}
		return nil, nil
	case checkoutStageDirtyTree:
		opt, ok := matchCheckoutOption(d.Options, reply)
		if !ok {
			return nil, nil
		}
		switch opt {
		case optDiscard:
			if err := discardCheckoutDirty(ctx, d.Dir); err != nil {
				return nil, err
			}
			// The tree is genuinely clean again — no accepted-dirty state to
			// remember (and an older one must not linger, or a future dirty
			// tree in the same directory would be waved through).
			a.clearDirtyAccepted()
			// Nothing of this PR is "wordt aangepast" any more either: the
			// edit is genuinely gone (same bookkeeping applyCancelCleanup
			// does for the chat-bubble version of this very question).
			clearChatPendingFiles(repo, pr)
		case optStashManual, optStashAuto:
			label := fmt.Sprintf("slash-chat-%s", time.Now().UTC().Format("20060102-150405"))
			if err := stashCheckoutDirty(ctx, d.Dir, label); err != nil {
				return nil, err
			}
			a.StashRef = label
			a.StashDir = d.Dir
			a.StashAutoRestore = opt == optStashAuto
			a.clearDirtyAccepted() // clean tree again, same as optDiscard above
			// Out of the working tree until it is popped again — not being
			// edited from the review tree's point of view either.
			clearChatPendingFiles(repo, pr)
		case optKeepSeparate:
			paths, err := snapshotDirtyPaths(ctx, d.Dir)
			if err != nil {
				return nil, err
			}
			a.KeepSeparatePaths = paths
			// The working tree is DELIBERATELY left dirty — Final, see the
			// type's own doc comment — so record that the reviewer accepted
			// exactly these paths, or the next turn asks all over again.
			a.acceptDirty(d.Dir, paths)
			return &chatCheckoutResolved{Dir: d.Dir, Final: true}, nil
		case optKeepCombined:
			// Nothing to do now — the ordinary `git add -A` at commit time
			// already includes it. Also Final, for the same reason, and the
			// same accepted-dirty bookkeeping (best-effort: an unreadable
			// status just means the question can come back).
			paths, err := snapshotDirtyPaths(ctx, d.Dir)
			if err == nil {
				a.acceptDirty(d.Dir, paths)
			}
			return &chatCheckoutResolved{Dir: d.Dir, Final: true}, nil
		}
		return &chatCheckoutResolved{Dir: d.Dir}, nil
	case checkoutStageLandingFailed:
		// Never actually reachable through the overlay's own UI (it offers no
		// Options for this stage, see checkoutStageLandingFailed's doc
		// comment), but any reply that DOES arrive for it — a stale click, a
		// direct API call — simply clears the notice rather than repeating
		// "Dat antwoord herkende ik niet als een van de keuzes" forever, the
		// unanswerable-question failure mode this whole file already guards
		// against for every other stage.
		return &chatCheckoutResolved{Dir: d.Dir}, nil
	}
	return nil, nil
}

// ---------------------------------------------------------------------------
// The one entry point runOneClaudeTurn/comment_batch.go call.
// ---------------------------------------------------------------------------

// prepareChatShellWorkDir resolves the ONE real, local work directory a write
// turn may edit directly for this PR, running (or continuing) the selection
// ladder above. reviewerReply is the reviewer's ANSWER to an already-pending
// choice and only ever comes from the work-directory overlay's own
// "checkoutAnswer" round trip — a chat turn passes "" and can therefore never
// have its ordinary message misread as an answer.
//
// Three outcomes:
//   - ok, decision == nil: dir is ready to edit right now.
//   - !ok, decision != nil: the reviewer must resolve something first — the
//     caller saves it as a chat.KindDirectoryDecision turn and returns.
//   - !ok, decision == nil: no candidate at all, or a hard git/gh failure —
//     the caller reports "no directory available" (best-effort/log-only on
//     the underlying error, mirroring every other degrade-gracefully path in
//     this file's history).
func prepareChatShellWorkDir(ctx context.Context, tm *TaskManager, dataDir, repo string, pr int, reviewerReply string) (dir string, decision *chatCheckoutDecision, ok bool) {
	meta, err := fetchPRMeta(ctx, repo, pr)
	if err != nil || meta.HeadRefName == "" {
		if tm != nil && tm.logf != nil {
			tm.logf("chat_checkout: pr %d: could not resolve head branch: %v", pr, err)
		}
		return "", nil, false
	}
	return prepareChatShellWorkDirAt(ctx, tm, dataDir, repo, pr, reviewerReply, meta.HeadRefName)
}

// prepareChatShellWorkDirAt is prepareChatShellWorkDir's body once the PR's
// head branch name is already known — split out for the same testability
// reason ensureChatShadowWorktreeAt/commitChatShadowEditsAt used to be: no
// gh/network call at all, only local/`origin`-remote git plumbing, so a test
// can exercise the real selection-ladder mechanics against a throwaway local
// repo.
func prepareChatShellWorkDirAt(ctx context.Context, tm *TaskManager, dataDir, repo string, pr int, reviewerReply, headRef string) (dir string, decision *chatCheckoutDecision, ok bool) {
	baseBranch := baseBranchFor(repo)
	slug := repoSlugFor(repo)

	a := getOrCreateCheckoutAssignment(dataDir, repo, pr)
	// Persist whichever a.Dir/a.Branch the loop below ends up leaving behind,
	// regardless of which of its several return points fires — see
	// persistCheckoutAssignment's own doc comment.
	defer persistCheckoutAssignment(dataDir, repo, pr, a)

	for attempt := 0; attempt < 4; attempt++ {
		if a.Pending != nil {
			if reviewerReply == "" {
				// An open choice and nothing to apply: this caller is a write
				// turn (or comment_batch/test_run) that just needs a
				// directory, not an answer. The answer itself only ever
				// arrives through the overlay's own "checkoutAnswer" round
				// trip. Feeding a chat message in here is exactly the
				// mix-up this whole mechanism was moved out of the chat for.
				//
				// But ask FIRST whether the choice is still a question at all
				// (checkoutPendingStillNeeded): if the reviewer resolved it
				// outside slash — committing the dirty tree, switching the
				// directory onto the PR's branch — drop it and just carry on
				// with this very turn instead of blocking it on a question
				// about a situation that is over.
				if !checkoutPendingStillNeeded(ctx, a, repo, pr, headRef, baseBranch) {
					a.Pending = nil
					publishCheckoutChanged(repo, pr) // close the overlay/chip
					continue
				}
				// Still genuinely open: the reviewer gets the same choice put
				// to them again, and the turn tells them so in words.
				return "", a.Pending, false
			}
			resolved, applyErr := applyCheckoutDecisionReply(ctx, a, repo, pr, headRef, reviewerReply)
			if applyErr != nil {
				if tm != nil && tm.logf != nil {
					tm.logf("chat_checkout: pr %d: applying decision reply: %v", pr, applyErr)
				}
				a.Pending = nil
				return "", nil, false
			}
			if resolved == nil {
				// Didn't match any offered option. Ask the SAME thing again, but
				// say so explicitly this time (a copy, so a.Pending itself keeps
				// its clean, canonical Body for the next attempt) — the root
				// cause of a real reported bug: a silent, unexplained repeat of
				// the identical question looked like the reviewer's answer had
				// been swallowed, when in fact it simply hadn't matched any
				// option byte-for-byte (matchCheckoutOption above is now also
				// trim/case-insensitive, which resolves the common case of this
				// on its own; this message is the fallback for a genuine
				// free-text mismatch).
				unresolved := *a.Pending
				unresolved.Body = "Dat antwoord herkende ik niet als een van de keuzes. " + unresolved.Body
				return "", &unresolved, false
			}
			a.Dir = resolved.Dir
			a.Pending = nil
			reviewerReply = "" // already consumed; never re-apply it below
			if resolved.Final {
				// Deliberately skip re-classification — see chatCheckoutResolved's
				// own doc comment (re-checking now would just re-trigger the exact
				// same decision, since nothing about the dirty state changed).
				releaseCheckoutDirFromOtherPRs(dataDir, repo, pr, a.Dir)
				return a.Dir, nil, a.Dir != ""
			}
			continue
		}

		if a.Dir != "" {
			cand, cerr := classifyCheckoutCandidate(ctx, a.Dir, headRef, baseBranch)
			if cerr != nil {
				if tm != nil && tm.logf != nil {
					tm.logf("chat_checkout: pr %d: %s no longer usable, re-running the ladder: %v", pr, a.Dir, cerr)
				}
				a.Dir = ""
				continue
			}
			if !cand.OnTargetBranch && !cand.MergedIntoBase {
				a.Dir = "" // switched away from under us to unrelated work
				continue
			}
			if !cand.OnTargetBranch {
				a.Pending = chatCheckoutReuseDecision(cand, headRef)
				publishCheckoutChanged(repo, pr)
				return "", a.Pending, false
			}
			// A dirty tree the reviewer already decided about ("los laten"/
			// "meenemen in de commit") is not a question any more — see
			// dirtyAlreadyAccepted just above applyCheckoutDecisionReply.
			if cand.Dirty && !dirtyAlreadyAccepted(ctx, a) {
				if dirtyIsOnlyPendingEdits(cand.DirtyPaths, repo, pr) {
					// Not the reviewer's own unrelated mess at all — another
					// conversation's turn already edited these exact files and
					// simply hasn't landed (committed) them yet (see
					// dirtyIsOnlyPendingEdits). Nothing to ask: this turn just
					// isn't ready yet, and will succeed on its own once that
					// landing completes.
					a.LastReason = "Een andere Claude-conversatie van deze PR is deze werkmap nog aan het landen. Probeer het zo weer."
					a.LastReasonTransient = true
					if tm != nil && tm.logf != nil {
						tm.logf("chat_checkout: pr %d: %s dirty with only another conversation's pending edit(s), not asking", pr, a.Dir)
					}
					return "", nil, false
				}
				a.Pending = chatCheckoutDirtyDecision(cand)
				publishCheckoutChanged(repo, pr)
				return "", a.Pending, false
			}
			// !cand.FastForwardable on its own (a clean working tree, just real
			// local commits origin doesn't have yet) is deliberately NOT a
			// question any more (reviewer decision: "je mag hier gewoon op
			// verder bouwen") — a write turn only ever COMMITS on top, it never
			// discards or force-overwrites anything, so there is nothing this
			// candidate's own history could lose by proceeding straight away.
			// See the removed checkoutStageDivergedHistory consult's own
			// history in chat_checkout_test.go for the bug this replaced (an
			// unanswerable loop once the reviewer typed anything other than the
			// literal button text).
			//
			// BehindOrigin is only meaningful (and only fast-forwarded here)
			// when FastForwardable is also true — ahead>0 together with
			// behind>0 is a real divergence in both directions, which a plain
			// `merge --ff-only` cannot resolve anyway; that case is left for
			// the eventual landing's own merge/conflict handling
			// (chat_merge.go's resolveCheckoutMerge), not guessed at here.
			if cand.FastForwardable && cand.BehindOrigin {
				if err := fastForwardCheckoutToOrigin(ctx, a.Dir, headRef); err != nil {
					if tm != nil && tm.logf != nil {
						tm.logf("chat_checkout: pr %d: fast-forward %s: %v", pr, a.Dir, err)
					}
					return "", nil, false
				}
			}
			a.Branch = headRef
			releaseCheckoutDirFromOtherPRs(dataDir, repo, pr, a.Dir)
			return a.Dir, nil, true
		}

		hold := checkoutHoldbackFor(repo, pr, a.Excluded)
		candidates, diag := listCheckoutCandidates(ctx, dataDir, slug, headRef, baseBranch, hold)
		if diag.Err != nil && tm != nil && tm.logf != nil {
			tm.logf("chat_checkout: pr %d: listing candidates: %v", pr, diag.Err)
		}
		ready, dec := selectCheckoutCandidate(candidates)
		switch {
		case ready != "":
			a.Dir = ready
			a.LastReason = ""
			a.LastReasonTransient = false
			continue
		case dec != nil:
			a.Pending = dec
			a.LastReason = ""
			a.LastReasonTransient = false
			publishCheckoutChanged(repo, pr)
			return "", dec, false
		}

		// Nothing free left. Rather than dead-ending on "there is no local
		// checkout, add a path to chatCheckoutDirs" — which was simply untrue
		// on a machine with several checkouts of this repo, all of them merely
		// held back (reported bug: "er is wel ruimte in ~/dev") — run the
		// ladder ONE more time with nothing held back at all and let the
		// reviewer pick from every directory that is usable by its own git
		// state. Never auto-picked, however few options are left: taking over
		// another PR's directory, or overruling one's own earlier "nee", is
		// always an explicit choice (checkoutLastResortDecision).
		if !hold.empty() {
			all, allDiag := listCheckoutCandidates(ctx, dataDir, slug, headRef, baseBranch, checkoutHoldback{})
			if allDiag.Err != nil && tm != nil && tm.logf != nil {
				tm.logf("chat_checkout: pr %d: listing held-back candidates: %v", pr, allDiag.Err)
			}
			if len(all) > 0 {
				a.Pending = checkoutLastResortDecision(all, hold)
				// The dead-end wording of the FIRST pass, kept for the moment
				// the reviewer answers "geen van deze" below.
				a.LastReason = diag.reason()
				a.LastReasonTransient = false
				publishCheckoutChanged(repo, pr)
				return "", a.Pending, false
			}
			diag = allDiag
		}
		a.LastReason = diag.reason()
		a.LastReasonTransient = false
		return "", nil, false
	}
	return "", nil, false
}

// ---------------------------------------------------------------------------
// Committing, landing, and the PR-wide "does this checkout still have
// something pending" reads.
// ---------------------------------------------------------------------------

// checkoutBranchMovedOnMsg is the exact reviewer-facing text a landing
// reports when the PR's real branch has moved on since the checkout's HEAD
// was last synced (so the landing would not be a plain fast-forward).
const checkoutBranchMovedOnMsg = "De PR-branch is intussen verder; jouw wijziging kon niet worden geland. Ververs en probeer opnieuw."

// checkoutNothingToLandMsg is commitCheckoutEditsAt's own "there was simply
// nothing new here" outcome (ahead == 0: the checkout's HEAD already matches
// origin/<headRefName>) — a chat.KindError only so the reviewer sees why
// nothing happened, NEVER a sign the checkout itself is broken. See
// isBlockingLandingFailure (chat_merge.go), which this exists for: this
// exact text used to raise the werkmap overlay's checkoutStageLandingFailed
// notice, a false positive reported live against PR 13729 — a "you already
// have nothing to land" outcome has none of the three generic overlay rows
// (Andere werkmap kiezen / Uit / Chat pauzeren) doing anything useful about
// it, because there was never a problem to act on.
const checkoutNothingToLandMsg = "Er is niets lokaal te landen."

// pendingLandedMsg is the reviewer-facing text for a successful landing —
// the one place that wording lives. It says three things on purpose: the
// change IS on the PR branch as slash sees it, it is NOT on GitHub yet (with
// a pointer at where the push lives), and WHERE it happened.
func pendingLandedMsg(headRefName, dir string) string {
	return fmt.Sprintf("Wijziging staat op `%s` (in `%s`) en is meteen zichtbaar in de review-tree. "+
		"Nog niet gepusht naar GitHub — dat doe je met de todo onderaan de index.", headRefName, dir)
}

// advancePendingRefFromCheckout fetches dir's current HEAD into the shared
// clone (a local, network-less fetch using dir itself as the "remote") and
// advances the PR's pending ref to it — fast-forward only, UNLESS allowAmend
// is set. This is the ONLY function that ever moves that ref forward now that
// a write turn commits directly onto the checkout's own real branch: there is
// nothing left to "reclaim" (dir is the reviewer's own, permanent checkout,
// not a disposable worktree), only the shared clone's read-model mirror to
// update.
//
// allowAmend is true from exactly one call site — commitCheckoutEditsAt,
// right after it ran `git commit --amend` on a commit amendableChatCommit
// already confirmed was unpushed — and lets the move skip the fast-forward
// check for that one, deliberate case: an amend rewrites the ref's current
// target rather than extending it, so the ordinary ancestor check would
// always (correctly, but wrongly here) refuse it. No other caller may pass
// true — that would turn this into a general non-fast-forward escape hatch,
// which is exactly what this function otherwise exists to prevent. The
// authoritative "was this commit ever pushed" check already happened, with a
// freshly fetched origin/<headRefName>, in amendableChatCommit just before
// the amend; nothing can move the ref in between because chat_merge's queue
// serializes this PR's landings one at a time.
//
// ingestMu-guarded: fetch/update-ref touch the shared clone's own refs, the
// same reason the old shadow-worktree plumbing took this lock.
func advancePendingRefFromCheckout(ctx context.Context, dir, repo string, pr int, headRefName string, allowAmend bool) error {
	ingestMu.Lock()
	defer ingestMu.Unlock()

	shaOut, err := runGitIn(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("resolve checkout HEAD: %w", err)
	}
	sha := strings.TrimSpace(string(shaOut))

	if _, err := runGitFor(ctx, repo, "fetch", dir, sha); err != nil {
		return fmt.Errorf("fetch checkout commit into shared clone: %w", err)
	}

	ref := prPendingRef(repo, pr, headRefName)
	if cur := pendingRefSHA(ctx, repo, ref); cur != "" && cur != sha {
		if _, err := runGitFor(ctx, repo, "merge-base", "--is-ancestor", cur, sha); err != nil && !allowAmend {
			return fmt.Errorf("landing %s would not be a fast-forward of %s", short(sha), short(cur))
		}
	}
	if _, err := runGitFor(ctx, repo, "update-ref", ref, sha); err != nil {
		return fmt.Errorf("update pending ref: %w", err)
	}
	return nil
}

// chatEditCommitSubject is the fixed subject line commitCheckoutEditsAt gives
// its OWN commits — never Claude's own free-text `git commit` run via Bash in
// a shell turn (chat_shell.md), which stays deliberately out of scope for
// amending: there is no fixed convention to recognize those by, and telling
// one apart from the reviewer's own manual commit in this same shared
// checkout would mean guessing. Recognition below matches ONLY this exact
// subject — positively, never "anything that isn't obviously manual".
const chatEditCommitSubject = "Claude: reviewer-requested edit"

// chatEditCommitMessage is the message for a brand-new chat-edit commit (no
// eligible previous chat commit to fold into) — subject line plus one bullet
// for this landing's conversation.
func chatEditCommitMessage(conversationID string) string {
	return chatEditCommitSubject + "\n\n- " + conversationID
}

// appendChatEditCommitMessage extends an existing chat-edit commit message
// with one more bullet, so amending several unpushed chat landings into one
// commit still shows every request that went into it — the reviewer picked
// "merge both messages" over silently keeping only the latest.
func appendChatEditCommitMessage(existing, conversationID string) string {
	return strings.TrimRight(existing, "\n") + "\n- " + conversationID
}

// amendableChatCommit reports whether dir's current HEAD is a safe target to
// fold a new chat edit into via `git commit --amend`, instead of stacking a
// new commit. All three must hold:
//
//  1. HEAD's subject is EXACTLY chatEditCommitSubject — so this only ever
//     matches a commit commitCheckoutEditsAt itself made, never Claude's own
//     free-text Bash commit and never a reviewer's manual commit in this same
//     checkout.
//  2. HEAD has exactly one parent — never fold into a merge commit (e.g. the
//     one resolveCheckoutMerge/chat_merge.go makes while resolving a real
//     conflict).
//  3. HEAD is NOT already reachable from origin/<headRefName> — a commit
//     that's already been pushed must never be rewritten. This is the
//     authoritative check (uses a fetch the caller already ran just before),
//     not the coarser branch-wide ahead/behind check further down.
//
// Returns HEAD's own current full message on success, so the caller can
// extend it with appendChatEditCommitMessage.
func amendableChatCommit(ctx context.Context, dir, headRefName string) (string, bool) {
	subjOut, err := runGitIn(ctx, dir, "log", "-1", "--format=%s", "HEAD")
	if err != nil || strings.TrimSpace(string(subjOut)) != chatEditCommitSubject {
		return "", false
	}
	parentsOut, err := runGitIn(ctx, dir, "rev-list", "--parents", "-n", "1", "HEAD")
	if err != nil || len(strings.Fields(strings.TrimSpace(string(parentsOut)))) != 2 {
		return "", false // 2 = the commit's own sha + exactly one parent
	}
	// merge-base --is-ancestor exits 0 exactly when HEAD is already reachable
	// from origin/<headRefName> — i.e. already pushed. That must refuse.
	if _, err := runGitIn(ctx, dir, "merge-base", "--is-ancestor", "HEAD", "origin/"+headRefName); err == nil {
		return "", false
	}
	msgOut, err := runGitIn(ctx, dir, "log", "-1", "--format=%B", "HEAD")
	if err != nil {
		return "", false
	}
	return strings.TrimRight(string(msgOut), "\n"), true
}

// commitCheckoutEditsAt is the "commit deze wijziging" Activity body once the
// PR's head branch name is already known: commit whatever Claude changed in
// the PR's assigned checkout and land it, fast-forward-only, on the PR's
// LOCAL pending ref — the push to GitHub is a separate, reviewer-triggered
// step (see pending_push.go). An ordinary "nothing to commit" or "branch
// moved on" outcome is expected, normal behaviour — never a Go error — only a
// genuinely unexpected git/gh failure would be, and even those are reported
// to the reviewer as a message rather than failing the workflow.
//
// If the checkout's current HEAD is itself still-unpushed, non-merge commit
// this same function made earlier (amendableChatCommit) — PR-wide, so this
// may be a different chat conversation's earlier landing — this edit is
// folded into it via `git commit --amend` instead of stacking a new commit,
// and the pending ref is moved onto the new (rewritten) SHA. See "Amending a
// chain of chat commits" in .claude/docs/pending-push.md.
// gitLockContentionRE matches the handful of git error messages that mean
// "another git process (or a stray leftover lock file) is holding this
// checkout's .git directory right now" — the class runGitInRetryOnLock below
// is meant to self-heal. This checkout is deliberately the reviewer's OWN,
// permanent local clone (see commitCheckoutEditsAt's own doc comment), not a
// disposable internal worktree, so it can genuinely have something else
// (an IDE, a terminal the reviewer is also using) touching it at the exact
// same moment a landing runs — unlike a real conflict or a rejected commit,
// this class is transient by nature and normally clears within
// milliseconds once the other process releases its lock.
var gitLockContentionRE = regexp.MustCompile(`(?i)\.lock['"]?\s*:|unable to create .*\.lock|cannot lock ref`)

// runGitInRetryOnLock runs one git command and, ONLY when it fails with a
// gitLockContentionRE-shaped message, waits briefly and tries exactly once
// more. Any other failure (a real conflict, a rejected commit, a genuine git
// error) returns immediately after the first attempt — this is deliberately
// not a general-purpose retry, only a narrow mitigation for the one class of
// failure that is not this code's own fault and is known to be transient.
func runGitInRetryOnLock(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, err := runGitIn(ctx, dir, args...)
	if err == nil || !gitLockContentionRE.MatchString(err.Error()) {
		return out, err
	}
	select {
	case <-time.After(300 * time.Millisecond):
	case <-ctx.Done():
		return out, err
	}
	return runGitIn(ctx, dir, args...)
}

func commitCheckoutEditsAt(ctx context.Context, cm *chat.Module, dataDir, repo string, pr int, conversationID, turnID, headRefName string) chat.Message {
	newMsg := func(body string, isErr bool) chat.Message {
		kind := ""
		if isErr {
			kind = chat.KindError
		}
		msg := chat.Message{
			ID: chatMessageID(turnID, ""), ConversationID: conversationID, PR: pr,
			Role: "assistant", Kind: kind, Body: body,
		}
		saveChatOutcomeMessage(ctx, cm, msg)
		return msg
	}

	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil || a.Dir == "" {
		return newMsg("Er is nog geen Claude-wijziging klaargezet om te committen.", true)
	}
	dir := a.Dir

	// Fetched BEFORE the commit/amend decision below: amendableChatCommit
	// needs an up-to-date origin/<headRefName> to tell "still unpushed" from
	// "already pushed" — deciding that against a stale ref would risk
	// rewriting a commit GitHub already has.
	//
	// An unreachable origin (no network, no credentials, an ssh-agent without
	// the key loaded) used to end the landing right here with "Kon de laatste
	// stand van de branch niet ophalen", throwing away an edit Claude had just
	// made — the same over-strict treatment of a REFRESH that cost the
	// reviewer their work directory one step earlier (see
	// classifyCheckoutCandidate). It degrades instead, but strictly on the
	// safe side: the ONE decision that genuinely needs fresh data is amending,
	// so a stale origin simply never amends and stacks an ordinary new commit.
	// That is never destructive, and the landing itself stays fast-forward-only
	// either way (advancePendingRefFromCheckout). Only a checkout that has no
	// local origin/<headRefName> at all is a real dead end: without any
	// reference point there is nothing to measure "what is new here" against.
	ingestMu.Lock()
	_, fetchErr := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "fetch", "origin", headRefName)
	ingestMu.Unlock()
	staleOrigin := fetchErr != nil
	if staleOrigin && !originRefExists(ctx, dir, headRefName) {
		return newMsg("Kon de laatste stand van `"+headRefName+"` niet ophalen (geen verbinding met origin), en deze werkmap kent die branch ook lokaal nog niet. De wijziging staat wel in `"+dir+"`.", true)
	}

	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain")
	if err != nil {
		return newMsg("Kon de status van de wijziging niet bepalen.", true)
	}
	amended := false
	if strings.TrimSpace(string(statusOut)) != "" {
		// Every git call in this block goes through runGitInRetryOnLock: this
		// checkout is the reviewer's own permanent clone, which can genuinely
		// have something else (an IDE, a terminal) touching its .git
		// directory at the same moment — see that function's own doc
		// comment. Not a proven fix for any specific past failure, only a
		// mitigation for the most likely transient cause; a real conflict or
		// rejected commit still fails immediately, now with the actual git
		// error logged AND shown (previously silently discarded here, unlike
		// the advancePendingRefFromCheckout failure a few lines below, which
		// already did this right) — a reported "Ik kan nu geen code
		// aanpassen"/"nieuwe poging" dead end (PR 13729) turned out to be
		// exactly this kind of failure with no way to find out why.
		if _, err := runGitInRetryOnLock(ctx, dir, "add", "-A"); err != nil {
			log.Printf("chat_checkout: pr %d: stage %s: %v", pr, dir, err)
			return newMsg("Kon de wijziging niet stagen (reden: "+err.Error()+").", true)
		}
		// "Los laten": keep the reviewer's own pre-existing, unrelated changes
		// OUT of Claude's commit, recorded once when that decision was made.
		for _, p := range a.KeepSeparatePaths {
			_, _ = runGitIn(ctx, dir, "restore", "--staged", "--", p)
		}
		// staleOrigin: see the fetch above — "is this commit already pushed?"
		// cannot be answered against a ref we could not refresh, so don't
		// rewrite history on a guess.
		if prevMsg, ok := amendableChatCommit(ctx, dir, headRefName); ok && !staleOrigin {
			if _, err := runGitInRetryOnLock(ctx, dir, "commit", "--amend", "-m", appendChatEditCommitMessage(prevMsg, conversationID)); err != nil {
				log.Printf("chat_checkout: pr %d: amend %s: %v", pr, dir, err)
				return newMsg("Kon de wijziging niet aan de vorige, nog niet gepushte commit toevoegen (reden: "+err.Error()+").", true)
			}
			amended = true
		} else if _, err := runGitInRetryOnLock(ctx, dir, "commit", "-m", chatEditCommitMessage(conversationID)); err != nil {
			log.Printf("chat_checkout: pr %d: commit %s: %v", pr, dir, err)
			return newMsg("Kon de wijziging niet committen (reden: "+err.Error()+").", true)
		}
	}
	// Else: nothing new to stage — but an earlier attempt may already have
	// committed locally without managing to land, so it's still worth trying.

	aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", "origin/"+headRefName+"..HEAD")
	if err != nil {
		return newMsg("Kon de status van de branch niet bepalen.", true)
	}
	ahead, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	if ahead == 0 {
		return newMsg(checkoutNothingToLandMsg, true)
	}
	behindOut, _ := runGitIn(ctx, dir, "rev-list", "--count", "HEAD..origin/"+headRefName)
	behind, _ := strconv.Atoi(strings.TrimSpace(string(behindOut)))
	if behind > 0 {
		return newMsg(checkoutBranchMovedOnMsg, true)
	}

	if err := advancePendingRefFromCheckout(ctx, dir, repo, pr, headRefName, amended); err != nil {
		// Logged AND shown: without this the only way to find out why was to
		// walk the checkout's/shared clone's git objects by hand (see the
		// PR-13608 case this was found against, .claude/docs/pending-push.md).
		log.Printf("chat_checkout: pr %d: land %s: %v", pr, dir, err)
		return newMsg("De wijziging kon niet op de PR-branch worden gezet (reden: "+err.Error()+").", true)
	}

	note := ""
	if a.StashAutoRestore && a.StashRef != "" {
		stashDir := a.StashDir
		if stashDir == "" {
			stashDir = dir
		}
		if err := popCheckoutStash(ctx, stashDir, a.StashRef); err != nil {
			note = " (Kon de eerder opgeslagen stash niet automatisch terugzetten — doe dit zelf met `git stash pop` in " + stashDir + ".)"
		} else {
			note = " (De eerder opgeslagen, niet-gerelateerde wijziging is teruggezet.)"
		}
		a.StashRef = ""
		a.StashDir = ""
		a.StashAutoRestore = false
	}
	a.KeepSeparatePaths = nil
	return newMsg(pendingLandedMsg(headRefName, dir)+note, false)
}

// chatCheckoutNeedsLanding is runOneClaudeTurn's own end-of-turn check (see
// "Automatic landing after a shell turn",
// .claude/docs/workflows-comments.md): does this PR's assigned checkout have
// anything — an uncommitted edit, or a local commit — that hasn't made it
// onto the PR's pending ref yet? PR-scoped now (there is only ONE shared
// checkout per PR), unlike the old per-conversation shadow check.
//
// Once the PR's pending ref (prPendingRef) already exists, HEAD is compared
// directly against it: a commit is only "not yet landed" if it differs from
// what was mirrored there last. This is deliberately NOT the same thing as
// "ahead of every remote-tracking branch" (the plain rev-list fallback
// below, used only before any pending ref exists for this PR/branch at
// all): a commit that already landed on the pending ref stays ahead of
// origin/<headRef> forever, because landing never pushes to GitHub — that
// push is the reviewer-gated todo row (pending_push.go), not this check.
// Without comparing against the pending ref, EVERY later turn of the same
// PR — including a plain read-only question that never touched the
// checkout — kept re-triggering the auto-land Activity and re-showing the
// "Wijziging staat op ..." bubble for a commit that had already been
// reported once (reviewer report: that notice appeared after a question
// that changed nothing at all).
func chatCheckoutNeedsLanding(ctx context.Context, dataDir, repo string, pr int) bool {
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil || a.Dir == "" {
		return false
	}
	statusOut, err := runGitIn(ctx, a.Dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		// Every git error here answers "nothing to land", which silently skips
		// the automatic landing altogether — so say so out loud. Reconstructing
		// one such skip (PR 13606, see chat_land_backstop.go) took walking the
		// event history and both clones by hand.
		log.Printf("chat_checkout: pr %d: needs-landing check: status in %s: %v", pr, a.Dir, err)
		return false
	}
	if strings.TrimSpace(string(statusOut)) != "" {
		return true
	}
	if a.Branch != "" {
		if landed := pendingRefSHA(ctx, repo, prPendingRef(repo, pr, a.Branch)); landed != "" {
			headOut, err := runGitIn(ctx, a.Dir, "rev-parse", "HEAD")
			if err != nil {
				log.Printf("chat_checkout: pr %d: needs-landing check: head in %s: %v", pr, a.Dir, err)
				return false
			}
			return strings.TrimSpace(string(headOut)) != landed
		}
	}
	aheadOut, err := runGitIn(ctx, a.Dir, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		log.Printf("chat_checkout: pr %d: needs-landing check: ahead count in %s: %v", pr, a.Dir, err)
		return false
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	return n > 0
}

// ---------------------------------------------------------------------------
// The per-TURN baseline: did THIS turn itself change the shared checkout?
// ---------------------------------------------------------------------------

// checkoutFingerprint is a cheap "what does this checkout look like right
// now" string: its HEAD sha plus its porcelain status. Two fingerprints
// differ exactly when a commit was made/rewritten or the working tree
// changed — which is all a turn-scoped "did anything happen here" check
// needs. Returns "" (never equal to a real fingerprint, and recorded as "no
// baseline at all") when the directory cannot be read.
func checkoutFingerprint(ctx context.Context, dir string) string {
	headOut, err := runGitIn(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return ""
	}
	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(headOut)) + "\n" + strings.TrimSpace(string(statusOut))
}

// chatTurnCheckoutBaseline holds, per conversation, the fingerprint of the
// PR's shared checkout as it was at the moment THIS turn was granted write
// access — recorded by runOneClaudeTurn right after prepareChatShellWorkDir
// resolved (and fetched/checked out) the directory. Only one turn per
// conversation ever runs at a time (the workflow drives them serially), so a
// plain per-conversation entry is enough.
//
// In-memory only, gone after a restart, never the source of truth about
// anything: git is, and a missing entry only means "no automatic landing for
// this turn" — the reviewer can always ask for a commit in plain words. Same
// operational carve-out as chatProgressByConv/chatCancelByConv, see
// .claude/rules/workflows-write-boundary.md.
var (
	chatTurnBaselineMu sync.Mutex
	chatTurnBaseline   = map[string]string{}
)

// recordTurnCheckoutBaseline snapshots dir for this conversation's running
// turn. A read-only turn never calls this, which is exactly what makes
// turnChangedCheckout below turn-scoped.
func recordTurnCheckoutBaseline(ctx context.Context, conversationID, dir string) {
	fp := checkoutFingerprint(ctx, dir)
	if fp == "" {
		// No baseline means turnChangedCheckout answers false for this turn,
		// so an edit it makes is never landed automatically — never silent.
		log.Printf("chat_checkout: conversation %s: no checkout baseline for %s", conversationID, dir)
	}
	chatTurnBaselineMu.Lock()
	defer chatTurnBaselineMu.Unlock()
	chatTurnBaseline[conversationID] = fp
}

// turnChangedCheckout answers the ONE question the automatic landing is
// allowed to act on: did the turn that just finished actually change this
// PR's checkout itself? It consumes the baseline (so a later turn can never
// re-read this one's), and answers false when there is no baseline at all —
// a turn that never escalated to write access, which is the reported bug:
// a pure question turn used to trigger the auto-land Activity and its
// "Wijziging staat op ..." bubble purely because the SHARED checkout already
// held something outstanding (the reviewer's own uncommitted work, or a local
// commit from earlier). Deliberately turn-scoped, not PR-wide: an earlier
// turn's failed landing is no longer retried by a later, unrelated turn
// (reviewer decision) — asking for a commit in plain words still works.
func turnChangedCheckout(ctx context.Context, dataDir, repo string, pr int, conversationID string) bool {
	chatTurnBaselineMu.Lock()
	before, ok := chatTurnBaseline[conversationID]
	delete(chatTurnBaseline, conversationID)
	chatTurnBaselineMu.Unlock()
	if !ok || before == "" {
		return false
	}
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil || a.Dir == "" {
		return false
	}
	return checkoutFingerprint(ctx, a.Dir) != before
}

// checkoutIsDirty is the plain "does the working tree have uncommitted
// changes right now" check raiseCancelCleanupChoice (chat_workflow.go) and
// applyCancelCleanup use — deliberately narrower than
// chatCheckoutNeedsLanding above (that one also counts local commits ahead of
// origin, which is irrelevant here: a cancelled turn's own tool calls only
// ever leave uncommitted edits, never a commit).
func checkoutIsDirty(ctx context.Context, dir string) (bool, error) {
	out, err := runGitIn(ctx, dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(out)) != "", nil
}

// chatCancelCleanupInput is applyCancelCleanup's own Activity input —
// Choice is one of optDiscard/optStashManual/optStashAuto/optKeepSeparate/
// optKeepCombined, verbatim, as offered on the chat.KindCleanupChoice bubble
// (a chat.KindCleanupChoice bubble stored before raiseCancelCleanupChoice
// moved that question into the werkmap overlay).
type chatCancelCleanupInput struct {
	Repo           string `json:"repo,omitempty"`
	PR             int    `json:"pr"`
	ConversationID string `json:"conversationId"`
	Choice         string `json:"choice"`
}

// applyCancelCleanup performs the reviewer's chosen cleanup for whatever a
// cancelled turn's own Edit/Bash tool calls left behind in the PR's shared
// checkout, and reports the outcome as a plain assistant message in the SAME
// conversation.
//
// Deliberately its OWN small mechanism, NOT chatCheckoutDecision/a.Pending
// above: that machinery's resolution path (prepareChatShellWorkDirAt's
// `resolved.Final` branch, chatCheckoutResumedPrompt) exists to let an
// EARLIER, still-open request continue once the checkout question is
// answered — so reusing it here would make resolving a post-cancel cleanup
// choice silently fire a brand-new Claude call, exactly what a reviewer
// asking to STOP a turn would never expect. This function never touches
// a.Pending/a.Dir's assignment at all, and never calls prepareChatShellWorkDir
// — it only runs the chosen git housekeeping against whichever checkout is
// CURRENTLY assigned to this PR, and re-checks dirtiness itself (the reviewer
// may take a while to answer, so nothing here is trusted from before).
func applyCancelCleanup(ctx context.Context, cm *chat.Module, dataDir string, arg chatCancelCleanupInput) {
	newMsg := func(body string) {
		msg := chat.Message{
			ID: "cleanup-" + newUIReactionID(), ConversationID: arg.ConversationID, PR: arg.PR,
			Role: "assistant", Body: body,
		}
		_ = cm.SaveMessage(ctx, msg)
	}
	a := getCheckoutAssignment(dataDir, arg.Repo, arg.PR)
	if a == nil || a.Dir == "" {
		newMsg("Er is niets meer om op te ruimen.")
		return
	}
	dir := a.Dir
	dirty, err := checkoutIsDirty(ctx, dir)
	if err != nil {
		newMsg("Kon de status van de checkout niet bepalen.")
		return
	}
	if !dirty {
		newMsg("Er stond niets meer klaar om op te ruimen.")
		return
	}
	switch arg.Choice {
	case optDiscard:
		if err := discardCheckoutDirty(ctx, dir); err != nil {
			newMsg("Weggooien is mislukt: " + err.Error())
			return
		}
		// The edit is genuinely gone — no longer "wordt aangepast" for any
		// block of this PR.
		clearChatPendingFiles(arg.Repo, arg.PR)
		publishCheckoutChanged(arg.Repo, arg.PR)
		newMsg("Weggegooid.")
	case optStashManual, optStashAuto:
		label := fmt.Sprintf("slash-chat-cancel-%s", time.Now().UTC().Format("20060102-150405"))
		if err := stashCheckoutDirty(ctx, dir, label); err != nil {
			newMsg("Stashen is mislukt: " + err.Error())
			return
		}
		a.StashRef = label
		a.StashDir = dir
		a.StashAutoRestore = arg.Choice == optStashAuto
		// Out of the working tree until it's popped again — not currently
		// "being edited" from the review tree's point of view either.
		clearChatPendingFiles(arg.Repo, arg.PR)
		publishCheckoutChanged(arg.Repo, arg.PR)
		newMsg("Weggestashed.")
	case optKeepSeparate:
		paths, perr := snapshotDirtyPaths(ctx, dir)
		if perr == nil {
			a.KeepSeparatePaths = paths
		}
		newMsg("Laten staan, buiten een volgende commit gehouden.")
	case optKeepCombined:
		newMsg("Laten staan.")
	default:
		newMsg("Onbekende keuze — niets gedaan.")
	}
}

// checkoutLocalPendingState is the read-only sibling handleChatShadowStatus
// (tasks_api.go) uses: the PR's ASSIGNED checkout's own dirty/ahead state, no
// fetch, no resolution attempt, no side effect. exists is false when this PR
// never resolved a checkout at all.
func checkoutLocalPendingState(ctx context.Context, dataDir, repo string, pr int) (exists, dirty bool, ahead int, dir string) {
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil || a.Dir == "" {
		return false, false, 0, ""
	}
	dir = a.Dir
	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return true, true, 0, dir // can't tell -> conservative, same as before
	}
	dirty = strings.TrimSpace(string(statusOut)) != ""
	aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		return true, dirty, 0, dir
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	return true, dirty, n, dir
}

// checkoutConflictedPaths reports the paths git still considers unmerged in
// dir (non-empty only right after a `git merge`/`git rebase` left conflict
// markers) — used both to decide whether an automatic merge needs Claude's
// help and, afterwards, to verify Claude actually resolved it.
func checkoutConflictedPaths(ctx context.Context, dir string) ([]string, error) {
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

// resolveConflictWithClaude asks Claude, agentically and read/write-scoped to
// dir (the PR's own assigned checkout), to resolve the given conflicted
// files, and reports whether every conflicted file is genuinely free of
// conflict markers afterwards — it never trusts the model's own claim, only
// the file contents. A one-shot Run (not RunChat): this is a mechanical fix,
// not a turn in the reviewer's own conversation.
//
// Deliberately NOT checkoutConflictedPaths here: that reads git's unmerged
// INDEX entries, which only a `git add` clears — and Claude's tool set here is
// Edit-only (no Bash, on purpose), so the index stayed unmerged no matter how
// perfectly the files were resolved. With that check this function could never
// return true: every real conflict degraded to the consult message and
// Claude's finished resolution was thrown away by the caller's
// `merge --abort`. The caller's own `git add -A` (resolveCheckoutMerge,
// chat_merge.go) is what clears the index right after this returns true.
func resolveConflictWithClaude(ctx context.Context, cl claude.Client, dir, conversationID string, conflicted []string) bool {
	if cl == nil {
		return false
	}
	req := claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       chatConflictPrompt(conversationID, conflicted),
		WorkDir:      dir,
		Tools:        []string{"Read", "Grep", "Glob", "Edit"},
		SystemPrompt: claude.ChatConflictSystemPrompt,
	}
	if _, err := cl.Run(ctx, req); err != nil {
		return false
	}
	return len(pathsWithConflictMarkers(dir, conflicted)) == 0
}

// conflictMarkerRe matches git's own conflict-marker lines (default marker
// size 7): the <<<<<<< / ||||||| / >>>>>>> lines with their label tail, and a
// bare ======= separator. A line of exactly seven '=' in legitimate content
// would false-positive, but the failure direction is safe — the merge then
// degrades to the consult message instead of committing broken content.
var conflictMarkerRe = regexp.MustCompile(`(?m)^(<{7}( |$)|\|{7}( |$)|>{7}( |$)|={7}$)`)

// pathsWithConflictMarkers reports which of paths (relative to dir) still
// contain a conflict-marker line. An unreadable file counts as unresolved —
// "unknown" must never pass a merge off as resolved.
func pathsWithConflictMarkers(dir string, paths []string) []string {
	var out []string
	for _, p := range paths {
		b, err := os.ReadFile(filepath.Join(dir, p))
		if err != nil || conflictMarkerRe.Match(b) {
			out = append(out, p)
		}
	}
	return out
}

// chatConflictPrompt is the call-specific half of the conflict-resolution
// prompt (the static instructions live in claude.ChatConflictSystemPrompt).
func chatConflictPrompt(conversationID string, conflicted []string) string {
	return fmt.Sprintf(
		"Er is een samenvoegconflict ontstaan tussen de wijziging van chat-conversatie %s en een andere, "+
			"inmiddels op de PR-branch gepushte wijziging. De volgende bestanden bevatten conflictmarkers "+
			"(<<<<<<<, =======, >>>>>>>):\n\n%s\n",
		conversationID, strings.Join(conflicted, "\n"),
	)
}

// ---------------------------------------------------------------------------
// The UI-menu actions (the chip next to "Live AI assistent"/theme in
// prInfoCard, src/home.mjs, and the PR-overview badge): "andere directory
// kiezen", "uit", "nu terugzetten" — see
// todo/todo-local-checkout-chat-edits.md's UI chapter. Each is dispatched
// from an Action on the existing chat_merge queue's Signal (chat_merge.go),
// never a direct write, exactly like the existing "push" Action.
// ---------------------------------------------------------------------------

// listAllCheckoutChoices is selectCheckoutCandidate's counterpart for an
// EXPLICIT "andere directory kiezen": unlike the ordinary ladder, it never
// auto-picks even when there is exactly one eligible candidate — the whole
// point of this menu item is that the reviewer chooses deliberately, per the
// design's own "toont de volledige lijst geldige kandidaten opnieuw, ook als
// er nu maar één is". Zero candidates still returns a decision (with no
// options) so the reviewer sees WHY nothing can be offered, rather than the
// menu silently doing nothing. Pure and dependency-free, like
// selectCheckoutCandidate, so it's unit-testable without any real git repo.
//
// hold only LABELS the options here (annotateCheckoutOption): the reviewer
// asking for this menu gets every directory offered regardless, including one
// another PR claims — with that claim named on the option itself, so the
// choice is informed rather than blind.
func listAllCheckoutChoices(candidates []checkoutCandidate, diag checkoutDiscovery, hold checkoutHoldback) *chatCheckoutDecision {
	if len(candidates) == 0 {
		body := "Geen lokale directory gevonden voor deze repo. Voeg een pad toe aan chatCheckoutDirs in settings.json of clone de repo lokaal."
		if r := diag.reason(); r != "" {
			body = r + " Los dat op, of voeg een pad toe aan chatCheckoutDirs in settings.json."
		}
		return &chatCheckoutDecision{
			Stage: checkoutStageChooseDirectory,
			Body:  body,
		}
	}
	opts := make([]string, 0, len(candidates))
	for _, c := range candidates {
		opts = append(opts, annotateCheckoutOption(c.Dir, hold))
	}
	return &chatCheckoutDecision{
		Stage:   checkoutStageChooseDirectory,
		Body:    "Kies welke lokale directory Claude voor deze PR gebruikt.",
		Options: opts,
	}
}

// relistCheckoutCandidates is the "andere directory kiezen" Activity body:
// drops the current assignment AND every earlier rejection (a "schone lei" —
// explicit reviewer request, unlike the ladder's own automatic exclusions)
// and re-lists every eligible candidate via listAllCheckoutChoices. The
// result is stored as the PR's pending decision (skipped when there are no
// options at all, so a directory becoming available later — "andere
// directory kiezen" tried again — starts completely fresh rather than being
// stuck on an empty, un-answerable decision).
func relistCheckoutCandidates(ctx context.Context, tm *TaskManager, dataDir, repo string, pr int) *chatCheckoutDecision {
	meta, err := fetchPRMeta(ctx, repo, pr)
	if err != nil || meta.HeadRefName == "" {
		if tm != nil && tm.logf != nil {
			tm.logf("chat_checkout: pr %d: relist: could not resolve head branch: %v", pr, err)
		}
		return nil
	}
	baseBranch := baseBranchFor(repo)
	slug := repoSlugFor(repo)

	a := getOrCreateCheckoutAssignment(dataDir, repo, pr)
	a.Dir = ""
	a.Branch = ""
	a.Pending = nil
	a.Excluded = map[string]bool{}
	persistCheckoutAssignment(dataDir, repo, pr, a)

	// Nothing held BACK here — an explicit "andere directory kiezen" shows
	// everything, a directory another PR claims included; the claim only ends
	// up as a label on that option (listAllCheckoutChoices). The claims are
	// read AFTER a.Dir was cleared above, so this PR's own former directory is
	// never labelled as somebody else's. Deliberately claims ONLY: the
	// reviewer's own rejections were just wiped by this very relist, so
	// labelling a directory with one would contradict the clean slate.
	hold := checkoutHoldback{Claimed: checkoutDirClaimsByOtherPRs(repo, pr)}
	candidates, diag := listCheckoutCandidates(ctx, dataDir, slug, meta.HeadRefName, baseBranch, checkoutHoldback{})
	if diag.Err != nil && tm != nil && tm.logf != nil {
		tm.logf("chat_checkout: pr %d: relist: listing candidates: %v", pr, diag.Err)
	}
	a.LastReason = diag.reason()
	a.LastReasonTransient = false
	dec := listAllCheckoutChoices(candidates, diag, hold)
	if len(dec.Options) > 0 {
		a.Pending = dec
	}
	return dec
}

// checkoutSetOff is the "uit" Activity body: forgets this PR's assigned
// checkout and any pending decision/exclusions, WITHOUT any git operation —
// a future write turn (or "andere directory kiezen") runs the ladder fresh.
// Deliberately leaves StashRef/StashDir/StashAutoRestore untouched: an
// unrestored stash must stay discoverable (via "nu terugzetten") even after
// the reviewer switches this PR off, since it is the ONE record of where
// that stash lives.
func checkoutSetOff(dataDir, repo string, pr int) {
	a := getOrCreateCheckoutAssignment(dataDir, repo, pr)
	a.Dir = ""
	a.Branch = ""
	a.Pending = nil
	a.Excluded = map[string]bool{}
	a.clearDirtyAccepted() // nothing is assigned any more, so nothing is accepted
	persistCheckoutAssignment(dataDir, repo, pr, a)
}

// checkoutRestoreStashNow is the "nu terugzetten" Activity body: pops a
// pending stash on demand, regardless of whether it was created with
// "automatisch terugzetten" or "zelf terugzetten" (see
// applyCheckoutDecisionReply's checkoutStageDirtyTree stash branches) — the
// reviewer explicitly asked for it right now. A no-op, not an error, when
// nothing is pending.
func checkoutRestoreStashNow(ctx context.Context, dataDir, repo string, pr int) error {
	a := getOrCreateCheckoutAssignment(dataDir, repo, pr)
	if a.StashRef == "" {
		return nil
	}
	dir := a.StashDir
	if dir == "" {
		dir = a.Dir
	}
	if dir == "" {
		return fmt.Errorf("no known directory for stash %q", a.StashRef)
	}
	if err := popCheckoutStash(ctx, dir, a.StashRef); err != nil {
		return err
	}
	a.StashRef = ""
	a.StashDir = ""
	a.StashAutoRestore = false
	return nil
}

// checkoutView is the read-only shape behind GET /api/chat/checkout — one PR's
// current local-checkout state for the chip (src/home.mjs) and the
// PR-overview badge (src/overview.mjs). A plain, in-memory read: no fetch, no
// git call, so this stays cheap enough for a page-load batch request.
type checkoutView struct {
	PR int `json:"pr"`
	// RunID is the chat_merge queue's own deterministic Run ID (see
	// chatMergeQueueRunID) — present unconditionally, like
	// pendingPushView.PushRunID, so the UI can ensure+signal it without
	// deriving the id itself. The Execution behind it may not exist yet
	// (nothing has landed/relisted for this PR) — callers ensure it first via
	// POST /api/workflows/chat_merge, exactly like autoWarn/claude_chat's own
	// bootstrap.
	RunID string `json:"runId"`
	// Dir/DirName/Branch are empty when nothing is assigned yet.
	Dir     string `json:"dir,omitempty"`
	DirName string `json:"dirName,omitempty"`
	Branch  string `json:"branch,omitempty"`
	// Decision is set whenever the reviewer must resolve something before a
	// write turn can proceed — answered via the "checkoutAnswer" Action.
	Decision *chatCheckoutDecision `json:"decision,omitempty"`
	// StashPending marks an earlier "stash" choice that hasn't been popped
	// yet — the chip's "nu terugzetten" row.
	StashPending bool `json:"stashPending,omitempty"`
	// PendingFiles are the repo-relative paths a not-yet-landed Claude edit
	// touched for this PR (chat_edit_pending.go) — the review-tree's own
	// per-block "wordt aangepast" status is driven straight off this list
	// (BlockList.mjs/Block.mjs), reusing the same read model/poll cadence the
	// checkout chip already has instead of a dedicated endpoint.
	PendingFiles []string `json:"pendingFiles,omitempty"`
	// RefreshingFiles are the repo-relative paths a JUST-LANDED Claude edit
	// touched, for which the review tree hasn't re-ingested yet
	// (chat_refresh_pending.go) — the gap between "ongepusht" (landed) and the
	// diff panel actually showing the new code. Drives the per-block "wordt
	// bijgewerkt" pill (BlockList.mjs/Block.mjs) and tells home.mjs's
	// `blocks.changed` handler that the next such event is this reviewer's OWN
	// landing finishing, not a colleague's push — see
	// .claude/docs/pending-push.md.
	RefreshingFiles []string `json:"refreshingFiles,omitempty"`
	// Waiting reports whether SOMETHING is queued right now behind this PR's
	// own checkout write-slot (isCheckoutWaiting, checkout_progress.go) — a
	// code-editing chat turn, a test run, the werkmap overlay's own answer/
	// relist/restore-stash, or the automatic post-turn landing. Surfaced on
	// the checkout chip (src/home.mjs) regardless of whether any of those has
	// its OWN visible progress line open right now, per the reviewer
	// requirement that a wait must always be a visible word, never silent.
	Waiting bool `json:"waiting,omitempty"`
}

// buildCheckoutView reads this PR's assignment (in-memory, seeded from the
// durable dir/branch on first touch since a restart — see
// getCheckoutAssignment/chat_checkout_store.go) — never nil, mirroring
// loadPendingPush's own "nothing yet" shape (an empty view, not an error) so
// a PR with no checkout activity at all still round-trips cleanly.
func buildCheckoutView(dataDir, repo string, pr int) checkoutView {
	v := checkoutView{
		PR:              pr,
		RunID:           chatMergeQueueRunID(repo, pr),
		PendingFiles:    chatPendingEditedFilesFor(repo, pr),
		RefreshingFiles: chatRefreshPendingFilesFor(repo, pr),
		Waiting:         isCheckoutWaiting(repo, pr),
	}
	a := getCheckoutAssignment(dataDir, repo, pr)
	if a == nil {
		return v
	}
	if a.Dir != "" {
		v.Dir = a.Dir
		v.DirName = filepath.Base(a.Dir)
		v.Branch = a.Branch
	}
	v.Decision = a.Pending
	v.StashPending = a.StashRef != ""
	return v
}
