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
//  3. If still nothing: no candidate at all — the write turn reports that
//     plainly and asks the reviewer to configure or clone one; there is NO
//     fallback to a disposable worktree any more.
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
	"os"
	"path/filepath"
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
// ingested, shared HEAD worktree (worktreeDirs, ingest.go) — never the
// reviewer's own checkout. No git fetch, no lock, no gh call at all: this
// directory is already on disk for any PR a comment (hence a chat) can exist
// on, and it is read by several other callers (blockstats.go, /api/code)
// without any locking, so a concurrent Read/Grep/Glob tool call here is no
// riskier than those.
func prepareChatReadOnlyWorkDir(dataDir string, repo string, pr int) (string, bool) {
	_, headDir := worktreeDirs(dataDir, repo, pr)
	if _, err := os.Stat(headDir); err != nil {
		return "", false
	}
	return headDir, true
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
}

// classifyCheckoutCandidate reads (and, via `git fetch`, refreshes the
// remote-tracking refs of) dir's current state. Never mutates the working
// tree or the checked-out branch itself.
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
		OnTargetBranch: branch == headRef,
	}

	if c.OnTargetBranch {
		if _, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "fetch", "origin", headRef); err != nil {
			return checkoutCandidate{}, fmt.Errorf("fetch %s in %s: %w", headRef, dir, err)
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
		c.BehindOrigin = behind > 0
		return c, nil
	}

	// A different branch is only ever a candidate at all when it is already
	// merged into the base branch — see the package doc comment.
	if _, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "fetch", "origin", baseBranch); err == nil {
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
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
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

// listCheckoutCandidates runs the full discovery ladder (steps 1-2) and
// classifies every directory that survives the "wrong repo" and "someone
// else's unfinished, unmerged branch" filters. excluded names directories the
// reviewer already explicitly rejected for this PR (see
// checkoutStageReuseMerged's "no" answer) so they are never offered again.
func listCheckoutCandidates(ctx context.Context, dataDir, repoSlug, headRef, baseBranch string, excluded map[string]bool) ([]checkoutCandidate, error) {
	seen := map[string]bool{}
	var out []checkoutCandidate
	var firstErr error

	add := func(rawDir string) {
		dir := expandTilde(strings.TrimSpace(rawDir))
		if dir == "" || seen[dir] || excluded[dir] {
			return
		}
		seen[dir] = true
		if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
			return // not a git working tree at all
		}
		if !checkoutRemoteMatchesSlug(ctx, dir, repoSlug) {
			return // wrong repo, or a fork
		}
		cand, err := classifyCheckoutCandidate(ctx, dir, headRef, baseBranch)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			return
		}
		if !cand.OnTargetBranch && !cand.MergedIntoBase {
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
	return out, firstErr
}

// selectCheckoutCandidate is the ladder's pure decision step, given already-
// classified candidates: no candidates -> nothing at all; more than one ->
// the reviewer always chooses (chooseDirectory); exactly one -> auto-picked
// (its own dirty/reuse state is resolved by the caller once it becomes the
// PR's assignment). Kept as a standalone, dependency-free function so it can
// be unit-tested without any real git repo.
func selectCheckoutCandidate(candidates []checkoutCandidate) (dir string, decision *chatCheckoutDecision) {
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
// interpreted correctly regardless of how the reviewer phrases it (an exact
// match against Options — free text simply doesn't resolve anything and the
// same question is asked again).
type chatCheckoutDecision struct {
	Stage   string
	Dir     string // the candidate this decision is about (all stages but chooseDirectory)
	Body    string
	Options []string
}

const (
	checkoutStageChooseDirectory = "chooseDirectory"
	checkoutStageReuseMerged     = "reuseMerged"
	checkoutStageDirtyTree       = "dirtyTree"
	checkoutStageDivergedHistory = "divergedHistory"
)

const (
	optDiscard         = "Verwijderen"
	optStashManual     = "Stash (ik zet het later zelf terug)"
	optStashAuto       = "Stash (automatisch terugzetten zodra dit gesprek de directory weer vrijgeeft)"
	optKeepSeparate    = "Los laten (buiten Claude's commit houden)"
	optKeepCombined    = "Meenemen in de commit"
	optReuseYes        = "Ja, gebruik deze directory voor deze PR"
	optReuseNo         = "Nee, zoek een andere directory"
	optProceedDiverged = "Doorgaan met de huidige lokale stand"
)

// chatCheckoutDirtyDecision builds the consult for a candidate that is either
// genuinely dirty (uncommitted changes) or clean but not fast-forwardable
// (real local commits origin doesn't have) — two different underlying
// problems, so two different Stages/option sets.
func chatCheckoutDirtyDecision(c checkoutCandidate) *chatCheckoutDecision {
	if !c.Dirty {
		return &chatCheckoutDecision{
			Stage: checkoutStageDivergedHistory, Dir: c.Dir,
			Body:    fmt.Sprintf("`%s` staat op branch `%s` met lokale commits die niet op GitHub staan. Ik wil die niet zomaar overschrijven.", c.Dir, c.Branch),
			Options: []string{optProceedDiverged},
		}
	}
	return &chatCheckoutDecision{
		Stage: checkoutStageDirtyTree, Dir: c.Dir,
		Body:    fmt.Sprintf("`%s` heeft nog niet-gerelateerde, niet-gecommitte wijzigingen. Wat moet daarmee gebeuren voordat ik hier iets aanpas?", c.Dir),
		Options: []string{optDiscard, optStashManual, optStashAuto, optKeepSeparate, optKeepCombined},
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

// ---------------------------------------------------------------------------
// The PR-scoped assignment: which checkout this PR is using, and what has
// already been decided about it. In-memory only, gone after a restart — the
// durable truth is git itself (which directory is on which branch, in what
// state), so losing this only costs re-running the ladder once. Same
// operational carve-out as pendingPushStatus (see
// .claude/rules/workflows-write-boundary.md).
// ---------------------------------------------------------------------------

type chatCheckoutAssignment struct {
	Dir     string
	Pending *chatCheckoutDecision
	// Excluded is every directory the reviewer explicitly rejected via
	// checkoutStageReuseMerged's "no" answer, for this PR's lifetime.
	Excluded map[string]bool
	// KeepSeparatePaths are the paths the reviewer chose to keep OUT of
	// Claude's own commit ("Los laten") — recorded once, at the moment the
	// dirty-tree decision was resolved, and consumed by commitCheckoutEditsAt.
	KeepSeparatePaths []string
	// StashRef/StashAutoRestore record a stash this resolution created, and
	// whether it should be popped automatically the next time this PR's
	// checkout lands a commit (see commitCheckoutEditsAt).
	StashRef         string
	StashAutoRestore bool
}

var (
	chatCheckoutMu   sync.Mutex
	chatCheckoutByPR = map[prKey]*chatCheckoutAssignment{}
)

func getOrCreateCheckoutAssignment(repo string, pr int) *chatCheckoutAssignment {
	key := prKey{Repo: repo, PR: pr}
	chatCheckoutMu.Lock()
	defer chatCheckoutMu.Unlock()
	a := chatCheckoutByPR[key]
	if a == nil {
		a = &chatCheckoutAssignment{Excluded: map[string]bool{}}
		chatCheckoutByPR[key] = a
	}
	return a
}

// getCheckoutAssignment is the read-only lookup — nil when this PR has never
// resolved a checkout at all (never creates one, unlike the function above).
func getCheckoutAssignment(repo string, pr int) *chatCheckoutAssignment {
	chatCheckoutMu.Lock()
	defer chatCheckoutMu.Unlock()
	return chatCheckoutByPR[prKey{Repo: repo, PR: pr}]
}

func hasPendingCheckoutDecision(repo string, pr int) bool {
	a := getCheckoutAssignment(repo, pr)
	return a != nil && a.Pending != nil
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
	return paths, nil
}

func checkoutOntoBranch(ctx context.Context, dir, headRef string) error {
	if _, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "fetch", "origin", headRef); err != nil {
		return err
	}
	_, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "checkout", "-B", headRef, "origin/"+headRef)
	return err
}

func fastForwardCheckoutToOrigin(ctx context.Context, dir, headRef string) error {
	if _, err := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "fetch", "origin", headRef); err != nil {
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

func applyCheckoutDecisionReply(ctx context.Context, a *chatCheckoutAssignment, headRef, reply string) (*chatCheckoutResolved, error) {
	d := a.Pending
	reply = strings.TrimSpace(reply)
	switch d.Stage {
	case checkoutStageChooseDirectory:
		for _, opt := range d.Options {
			if opt == reply {
				return &chatCheckoutResolved{Dir: opt}, nil
			}
		}
		return nil, nil
	case checkoutStageReuseMerged:
		switch reply {
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
	case checkoutStageDivergedHistory:
		if reply == optProceedDiverged {
			return &chatCheckoutResolved{Dir: d.Dir, Final: true}, nil
		}
		return nil, nil
	case checkoutStageDirtyTree:
		switch reply {
		case optDiscard:
			if err := discardCheckoutDirty(ctx, d.Dir); err != nil {
				return nil, err
			}
		case optStashManual, optStashAuto:
			label := fmt.Sprintf("slash-chat-%s", time.Now().UTC().Format("20060102-150405"))
			if err := stashCheckoutDirty(ctx, d.Dir, label); err != nil {
				return nil, err
			}
			a.StashRef = label
			a.StashAutoRestore = reply == optStashAuto
		case optKeepSeparate:
			paths, err := snapshotDirtyPaths(ctx, d.Dir)
			if err != nil {
				return nil, err
			}
			a.KeepSeparatePaths = paths
			// The working tree is DELIBERATELY left dirty — Final, see the
			// type's own doc comment.
			return &chatCheckoutResolved{Dir: d.Dir, Final: true}, nil
		case optKeepCombined:
			// Nothing to do now — the ordinary `git add -A` at commit time
			// already includes it. Also Final, for the same reason.
			return &chatCheckoutResolved{Dir: d.Dir, Final: true}, nil
		default:
			return nil, nil
		}
		return &chatCheckoutResolved{Dir: d.Dir}, nil
	}
	return nil, nil
}

// ---------------------------------------------------------------------------
// The one entry point runOneClaudeTurn/comment_batch.go call.
// ---------------------------------------------------------------------------

// prepareChatShellWorkDir resolves the ONE real, local checkout a write turn
// may edit directly for this PR, running (or continuing) the selection
// ladder above. reviewerReply is the CURRENT turn's message body, consulted
// ONLY to resolve an already-pending decision for this PR — ignored
// otherwise (a fresh resolution never needs it).
//
// Three outcomes:
//   - ok, decision == nil: dir is ready to edit right now.
//   - !ok, decision != nil: the reviewer must resolve something first — the
//     caller saves it as a chat.KindDirectoryDecision turn and returns.
//   - !ok, decision == nil: no candidate at all, or a hard git/gh failure —
//     the caller reports "no directory available" (best-effort/log-only on
//     the underlying error, mirroring every other degrade-gracefully path in
//     this file's history).
func prepareChatShellWorkDir(ctx context.Context, tm *TaskManager, dataDir, repo string, pr int, conversationID, reviewerReply string) (dir string, decision *chatCheckoutDecision, ok bool) {
	meta, err := fetchPRMeta(ctx, repo, pr)
	if err != nil || meta.HeadRefName == "" {
		if tm != nil && tm.logf != nil {
			tm.logf("chat_checkout: pr %d: could not resolve head branch: %v", pr, err)
		}
		return "", nil, false
	}
	return prepareChatShellWorkDirAt(ctx, tm, dataDir, repo, pr, conversationID, reviewerReply, meta.HeadRefName)
}

// prepareChatShellWorkDirAt is prepareChatShellWorkDir's body once the PR's
// head branch name is already known — split out for the same testability
// reason ensureChatShadowWorktreeAt/commitChatShadowEditsAt used to be: no
// gh/network call at all, only local/`origin`-remote git plumbing, so a test
// can exercise the real selection-ladder mechanics against a throwaway local
// repo.
func prepareChatShellWorkDirAt(ctx context.Context, tm *TaskManager, dataDir, repo string, pr int, conversationID, reviewerReply, headRef string) (dir string, decision *chatCheckoutDecision, ok bool) {
	baseBranch := baseBranchFor(repo)
	slug := repoSlugFor(repo)

	a := getOrCreateCheckoutAssignment(repo, pr)

	for attempt := 0; attempt < 4; attempt++ {
		if a.Pending != nil {
			resolved, applyErr := applyCheckoutDecisionReply(ctx, a, headRef, reviewerReply)
			if applyErr != nil {
				if tm != nil && tm.logf != nil {
					tm.logf("chat_checkout: pr %d: applying decision reply: %v", pr, applyErr)
				}
				a.Pending = nil
				return "", nil, false
			}
			if resolved == nil {
				// Didn't match any offered option — ask the SAME thing again.
				return "", a.Pending, false
			}
			a.Dir = resolved.Dir
			a.Pending = nil
			reviewerReply = "" // already consumed; never re-apply it below
			if resolved.Final {
				// Deliberately skip re-classification — see chatCheckoutResolved's
				// own doc comment (re-checking now would just re-trigger the exact
				// same decision, since nothing about the dirty state changed).
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
				return "", a.Pending, false
			}
			if cand.Dirty || !cand.FastForwardable {
				a.Pending = chatCheckoutDirtyDecision(cand)
				return "", a.Pending, false
			}
			if cand.BehindOrigin {
				if err := fastForwardCheckoutToOrigin(ctx, a.Dir, headRef); err != nil {
					if tm != nil && tm.logf != nil {
						tm.logf("chat_checkout: pr %d: fast-forward %s: %v", pr, a.Dir, err)
					}
					return "", nil, false
				}
			}
			return a.Dir, nil, true
		}

		candidates, lerr := listCheckoutCandidates(ctx, dataDir, slug, headRef, baseBranch, a.Excluded)
		if lerr != nil && tm != nil && tm.logf != nil {
			tm.logf("chat_checkout: pr %d: listing candidates: %v", pr, lerr)
		}
		ready, dec := selectCheckoutCandidate(candidates)
		switch {
		case ready != "":
			a.Dir = ready
			continue
		case dec != nil:
			a.Pending = dec
			return "", dec, false
		default:
			return "", nil, false
		}
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
// advances the PR's pending ref to it — fast-forward only. This is the ONLY
// function that ever moves that ref forward now that a write turn commits
// directly onto the checkout's own real branch: there is nothing left to
// "reclaim" (dir is the reviewer's own, permanent checkout, not a disposable
// worktree), only the shared clone's read-model mirror to update.
//
// ingestMu-guarded: fetch/update-ref touch the shared clone's own refs, the
// same reason the old shadow-worktree plumbing took this lock.
func advancePendingRefFromCheckout(ctx context.Context, dir, repo string, pr int, headRefName string) error {
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
		if _, err := runGitFor(ctx, repo, "merge-base", "--is-ancestor", cur, sha); err != nil {
			return fmt.Errorf("landing %s would not be a fast-forward of %s", short(sha), short(cur))
		}
	}
	if _, err := runGitFor(ctx, repo, "update-ref", ref, sha); err != nil {
		return fmt.Errorf("update pending ref: %w", err)
	}
	return nil
}

// commitCheckoutEditsAt is the "commit deze wijziging" Activity body once the
// PR's head branch name is already known: commit whatever Claude changed in
// the PR's assigned checkout and land it, fast-forward-only, on the PR's
// LOCAL pending ref — the push to GitHub is a separate, reviewer-triggered
// step (see pending_push.go). An ordinary "nothing to commit" or "branch
// moved on" outcome is expected, normal behaviour — never a Go error — only a
// genuinely unexpected git/gh failure would be, and even those are reported
// to the reviewer as a message rather than failing the workflow.
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
		_ = cm.SaveMessage(ctx, msg)
		return msg
	}

	a := getCheckoutAssignment(repo, pr)
	if a == nil || a.Dir == "" {
		return newMsg("Er is nog geen Claude-wijziging klaargezet om te committen.", true)
	}
	dir := a.Dir

	statusOut, err := runGitIn(ctx, dir, "status", "--porcelain")
	if err != nil {
		return newMsg("Kon de status van de wijziging niet bepalen.", true)
	}
	if strings.TrimSpace(string(statusOut)) != "" {
		if _, err := runGitIn(ctx, dir, "add", "-A"); err != nil {
			return newMsg("Kon de wijziging niet stagen.", true)
		}
		// "Los laten": keep the reviewer's own pre-existing, unrelated changes
		// OUT of Claude's commit, recorded once when that decision was made.
		for _, p := range a.KeepSeparatePaths {
			_, _ = runGitIn(ctx, dir, "restore", "--staged", "--", p)
		}
		if _, err := runGitIn(ctx, dir, "commit", "-m", "Claude: reviewer-requested edit ("+conversationID+")"); err != nil {
			return newMsg("Kon de wijziging niet committen.", true)
		}
	}
	// Else: nothing new to stage — but an earlier attempt may already have
	// committed locally without managing to land, so it's still worth trying.

	ingestMu.Lock()
	_, fetchErr := runGitIn(ctx, dir, "-c", "submodule.recurse=false", "fetch", "origin", headRefName)
	ingestMu.Unlock()
	if fetchErr != nil {
		return newMsg("Kon de laatste stand van de branch niet ophalen.", true)
	}
	aheadOut, err := runGitIn(ctx, dir, "rev-list", "--count", "origin/"+headRefName+"..HEAD")
	if err != nil {
		return newMsg("Kon de status van de branch niet bepalen.", true)
	}
	ahead, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	if ahead == 0 {
		return newMsg("Er is niets lokaal te landen.", true)
	}
	behindOut, _ := runGitIn(ctx, dir, "rev-list", "--count", "HEAD..origin/"+headRefName)
	behind, _ := strconv.Atoi(strings.TrimSpace(string(behindOut)))
	if behind > 0 {
		return newMsg(checkoutBranchMovedOnMsg, true)
	}

	if err := advancePendingRefFromCheckout(ctx, dir, repo, pr, headRefName); err != nil {
		return newMsg("De wijziging kon niet op de PR-branch worden gezet.", true)
	}

	note := ""
	if a.StashAutoRestore && a.StashRef != "" {
		if err := popCheckoutStash(ctx, dir, a.StashRef); err != nil {
			note = " (Kon de eerder opgeslagen stash niet automatisch terugzetten — doe dit zelf met `git stash pop` in " + dir + ".)"
		} else {
			note = " (De eerder opgeslagen, niet-gerelateerde wijziging is teruggezet.)"
		}
		a.StashRef = ""
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
func chatCheckoutNeedsLanding(ctx context.Context, repo string, pr int) bool {
	a := getCheckoutAssignment(repo, pr)
	if a == nil || a.Dir == "" {
		return false
	}
	statusOut, err := runGitIn(ctx, a.Dir, "status", "--porcelain", "--ignore-submodules=all")
	if err != nil {
		return false
	}
	if strings.TrimSpace(string(statusOut)) != "" {
		return true
	}
	aheadOut, err := runGitIn(ctx, a.Dir, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		return false
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(aheadOut)))
	return n > 0
}

// checkoutLocalPendingState is the read-only sibling handleChatShadowStatus
// (tasks_api.go) uses: the PR's ASSIGNED checkout's own dirty/ahead state, no
// fetch, no resolution attempt, no side effect. exists is false when this PR
// never resolved a checkout at all.
func checkoutLocalPendingState(ctx context.Context, repo string, pr int) (exists, dirty bool, ahead int, dir string) {
	a := getCheckoutAssignment(repo, pr)
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
// files, and reports whether the working tree is genuinely clean afterwards —
// it never trusts the model's own claim, only git's own conflict list. A
// one-shot Run (not RunChat): this is a mechanical fix, not a turn in the
// reviewer's own conversation.
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
	remaining, err := checkoutConflictedPaths(ctx, dir)
	if err != nil {
		return false
	}
	return len(remaining) == 0
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
