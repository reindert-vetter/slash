package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"slash/modules/chat"
)

// chat_checkout_test.go covers the git-plumbing halves that don't need gh/
// network access (prepareChatShellWorkDirAt/commitCheckoutEditsAt), the same
// testability seam ingest.go's own Locked-suffixed functions exist for — see
// TestIngestWorkflowEndToEnd's own doc comment on why fetchPRMeta itself (the
// gh-calling wrapper) has no offline fake and is therefore left untested here.
//
// Every test builds its own throwaway "remote" (a bare repo) plus a "shared
// clone" it points SLASH_REPO_DIR at (setupChatShadowRepo — the historical
// name, kept because several OTHER test files already depend on it too), so
// runGit/runGitIn (both hardwired to repoDir()) never touch the real
// developer clone. A separate, THIRD directory (cloneCheckoutDir) stands in
// for "the reviewer's own local checkout" — the thing chat_checkout.go
// actually edits now, never the shared clone itself.

// setupChatShadowRepo creates a bare "origin" repo with one commit on
// headRefName, a local clone of it (used as repoDir() for the duration of the
// test via t.Setenv), and returns the bare repo's path (for advancing origin
// directly, simulating someone else pushing) plus the local clone's path.
func setupChatShadowRepo(t *testing.T, headRefName, fileContent string) (bareDir, cloneDir string) {
	t.Helper()
	root := t.TempDir()
	bareDir = filepath.Join(root, "origin.git")
	seedDir := filepath.Join(root, "seed")
	cloneDir = filepath.Join(root, "clone")

	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
		}
	}

	if err := os.MkdirAll(seedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.Command("git", "init", "--bare", bareDir).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v", err)
	}
	run(seedDir, "init")
	run(seedDir, "config", "user.email", "test@example.com")
	run(seedDir, "config", "user.name", "test")
	run(seedDir, "checkout", "-b", headRefName)
	if err := os.WriteFile(filepath.Join(seedDir, "foo.txt"), []byte(fileContent), 0o644); err != nil {
		t.Fatal(err)
	}
	run(seedDir, "add", "foo.txt")
	run(seedDir, "commit", "-m", "seed")
	run(seedDir, "remote", "add", "origin", bareDir)
	run(seedDir, "push", "origin", headRefName)

	if _, err := exec.Command("git", "clone", bareDir, cloneDir).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v", err)
	}
	run(cloneDir, "config", "user.email", "test@example.com")
	run(cloneDir, "config", "user.name", "test")

	t.Setenv("SLASH_REPO_DIR", cloneDir)
	return bareDir, cloneDir
}

// pushToBare simulates "someone else pushed a new commit" directly onto the
// bare origin's headRefName, independent of anything this test's own checkout
// is doing.
func pushToBare(t *testing.T, bareDir, headRefName, fileContent string) {
	t.Helper()
	tmp := t.TempDir()
	seed := filepath.Join(tmp, "advance")
	if _, err := exec.Command("git", "clone", "--branch", headRefName, bareDir, seed).CombinedOutput(); err != nil {
		t.Fatalf("clone to advance origin: %v", err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", seed}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(seed, "foo.txt"), []byte(fileContent), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "advance")
	run("push", "origin", headRefName)
}

// cloneCheckoutDir stands in for "the reviewer's own, already-existing local
// checkout" — a real clone of source (a bare repo, or the shared clone
// itself), checked out on branch, with a usable git identity. Every write-
// path test builds one of these instead of a disposable worktree.
//
// Deliberately a PLAIN clone (no `--branch`) followed by an explicit
// `checkout -B branch origin/branch`, rather than `git clone --branch
// branch`: several fixtures (setupChatShadowRepo's own cloneDir in
// particular) have branch reachable only as a remote-tracking ref, not as a
// real local branch — `git init --bare`'s HEAD symref does not necessarily
// point at it — and `git clone --branch` cannot see through that when
// SOURCE itself is a non-bare working copy. A plain clone always pulls every
// ref regardless, so this works uniformly whatever source's own checked-out
// branch happens to be.
//
// Also tags a SECOND remote ("slug-tag") at a synthetic GitHub URL for
// repoSlug — checkoutRemoteMatchesSlug inspects every remote, and this test
// harness's real "origin" is a local bare-repo/clone PATH, which never looks
// like a GitHub URL at all. Never touches "origin" itself, which stays the
// real fetch/push target these tests exercise. A test that specifically
// needs a NON-matching (fork) remote overwrites this one afterwards.
func cloneCheckoutDir(t *testing.T, source, branch string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "checkout")
	if out, err := exec.Command("git", "clone", source, dir).CombinedOutput(); err != nil {
		t.Fatalf("git clone checkout: %v: %s", err, out)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	run("checkout", "-B", branch, "origin/"+branch)
	run("remote", "add", "slug-tag", "https://github.com/"+repoSlug+".git")
	return dir
}

// writeCheckoutSettings drops a settings.json with `chatCheckoutDirs` for the
// (test) primary repo into dataDir — the explicit-registry half of the
// selection ladder (chat_checkout.go's chatCheckoutRegistryDirs), read fresh
// on every resolution, never through the cached global registry (repos.go),
// so this needs no initRepos call at all.
func writeCheckoutSettings(t *testing.T, dataDir string, dirs ...string) {
	t.Helper()
	// Isolate the home-dir-scan fallback from whatever real checkouts happen
	// to exist on the machine running this test — every test using this
	// helper already registers its own explicit candidates, so the scan
	// should never be reached at all; if it ever is (a bug), it must find
	// nothing rather than something real.
	t.Setenv("SLASH_CHECKOUT_HOME_DIR", t.TempDir())
	body, err := json.Marshal(map[string]any{
		"repos": []map[string]any{
			{"slug": repoSlug, "chatCheckoutDirs": dirs},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "settings.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

// assignCheckoutForTest registers dir directly as the resolved checkout for
// (repo, pr) — skipping the discovery ladder entirely, for tests that only
// care about what happens AFTER a checkout is already assigned (committing,
// landing, merging, "does this PR still have unlanded work"). Every test
// using this picks its own unique pr number, since the assignment map is
// process-global (mirrors every other test in this file picking a unique PR
// number for the same reason the old per-conversation worktree tests did).
func assignCheckoutForTest(t *testing.T, repo string, pr int, dir string) {
	t.Helper()
	getOrCreateCheckoutAssignment(repo, pr).Dir = dir
}

// assignPendingDecisionForTest registers this PR's pending work-directory
// choice directly — skipping the discovery ladder — for the end-to-end
// regression test (chat_workflow_test.go) proving an ordinary, read-only chat
// turn never even touches it.
func assignPendingDecisionForTest(t *testing.T, repo string, pr int, decision *chatCheckoutDecision) {
	t.Helper()
	getOrCreateCheckoutAssignment(repo, pr).Pending = decision
}

func TestPrepareChatShellWorkDirPicksSoleRegisteredCandidate(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "hello\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1001, "", "feature/x")
	if decision != nil {
		t.Fatalf("unexpected decision: %+v", decision)
	}
	if !ok {
		t.Fatal("expected a ready checkout, got !ok")
	}
	if dir != checkout {
		t.Fatalf("dir = %q, want %q", dir, checkout)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "foo.txt")); err != nil || string(got) != "hello\n" {
		t.Fatalf("checkout content = %q, err %v; want hello\\n", got, err)
	}
}

func TestPrepareChatShellWorkDirFastForwardsWhenCleanAndBehind(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	dir, _, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1002, "", "feature/x")
	if !ok {
		t.Fatal("first resolve: expected ok")
	}

	// The real branch moves on — a clean checkout must fast-forward silently,
	// no reviewer decision needed.
	pushToBare(t, bareDir, "feature/x", "v2\n")

	dir2, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1002, "", "feature/x")
	if decision != nil {
		t.Fatalf("unexpected decision on a clean, behind checkout: %+v", decision)
	}
	if !ok {
		t.Fatal("second resolve: expected ok")
	}
	if dir2 != dir {
		t.Fatalf("dir changed: %q vs %q", dir, dir2)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "foo.txt")); string(got) != "v2\n" {
		t.Fatalf("checkout content after fast-forward = %q, want v2\\n", got)
	}
}

// A CLEAN checkout that is already on the PR's own branch, with real local
// commits origin doesn't have yet, is used straight away — no question at
// all (reviewer decision: "je mag hier gewoon op verder bouwen", the fix for
// a reported infinite-loop bug: the removed checkoutStageDivergedHistory
// consult's one option, "Doorgaan met de huidige lokale stand", could never
// be typed back byte-exactly, so it re-asked itself forever).
func TestPrepareChatShellWorkDirProceedsOnUnpushedLocalCommits(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	// A local commit the checkout's own remote-tracking ref doesn't know
	// about — same shape as a reviewer-requested Claude edit that already
	// landed in an earlier turn.
	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("local WIP, committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	commit := exec.Command("git", "-C", checkout, "commit", "-am", "local work not yet on origin")
	if out, err := commit.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v: %s", err, out)
	}

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1013, "", "feature/x")
	if decision != nil {
		t.Fatalf("expected no decision at all for a clean, merely-ahead checkout, got %+v", decision)
	}
	if !ok || dir != checkout {
		t.Fatalf("expected the checkout ready immediately, dir=%q ok=%v", dir, ok)
	}
	if got, _ := os.ReadFile(filepath.Join(checkout, "foo.txt")); string(got) != "local WIP, committed\n" {
		t.Fatalf("expected the local commit left untouched, got %q", got)
	}
}

// A dirty checkout is never silently touched — the reviewer must resolve a
// chatCheckoutDecision first, and the SAME question is re-asked until a
// reply matches one of the offered options.
func TestPrepareChatShellWorkDirAsksAboutDirtyCandidate(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1003, "", "feature/x")
	if ok || dir != "" {
		t.Fatalf("expected no ready dir for a dirty checkout, got dir=%q ok=%v", dir, ok)
	}
	if decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a dirtyTree decision, got %+v", decision)
	}

	// An unrecognized reply re-asks the SAME thing rather than guessing — but
	// now says so explicitly, instead of silently repeating an identical
	// question (the root cause of a reported infinite loop, see
	// TestPrepareChatShellWorkDirCaseInsensitiveMatch below).
	_, decision2, ok2 := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1003, "iets anders", "feature/x")
	if ok2 || decision2 == nil || decision2.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected the same dirtyTree decision again, got ok=%v decision=%+v", ok2, decision2)
	}
	if !strings.Contains(decision2.Body, "herkende ik niet") {
		t.Fatalf("expected the repeated decision to explain the mismatch, got body %q", decision2.Body)
	}

	// "Los laten": the pre-existing change is excluded from Claude's own
	// commit later, and the checkout becomes usable right away.
	dir3, decision3, ok3 := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1003, optKeepSeparate, "feature/x")
	if decision3 != nil {
		t.Fatalf("unexpected further decision: %+v", decision3)
	}
	if !ok3 || dir3 != checkout {
		t.Fatalf("expected the checkout ready after resolving, dir=%q ok=%v", dir3, ok3)
	}
	if got, _ := os.ReadFile(filepath.Join(checkout, "foo.txt")); string(got) != "reviewer's own WIP\n" {
		t.Fatalf("'los laten' must not touch the working tree, got %q", got)
	}
}

// The work-directory choice is a PR-wide setting, not a question inside a
// conversation: a caller that only needs a directory (a write turn,
// comment_batch, test_run — all of which pass reviewerReply "") gets the open
// choice reported back untouched, over and over, and can never accidentally
// "answer" it. Only the overlay's own answer resolves it.
//
// Reported bug this replaced: while one conversation had an open decision,
// another conversation's turn was handed an unanswerable "Een andere
// Claude-conversatie wacht nog op een keuze" bubble pointing at a chat the UI
// cannot even find; before THAT, an unrelated turn's ordinary message was fed
// in as an attempted answer and came back as "Dat antwoord herkende ik niet
// als een van de keuzes".
func TestPrepareChatShellWorkDirChoiceIsNeverAnsweredByACallerThatOnlyNeedsADir(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The first write turn discovers the dirty tree and raises the choice.
	_, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970801, "", "feature/x")
	if ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a dirtyTree choice to be raised, got ok=%v decision=%+v", ok, decision)
	}
	if !checkoutChoiceOpen("", 970801) {
		t.Fatal("the raised choice must be reported as open")
	}
	raised := getCheckoutAssignment("", 970801).Pending

	// Any further "I just need a directory" call reports the SAME open choice
	// and leaves it byte-for-byte alone — no re-ask, no "herkende ik niet",
	// no second question of its own.
	_, again, okAgain := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970801, "", "feature/x")
	if okAgain {
		t.Fatal("no directory may be handed out while the choice is open")
	}
	if again != raised {
		t.Fatalf("expected the very same open choice back, got %+v", again)
	}
	if strings.Contains(again.Body, "herkende ik niet") {
		t.Fatalf("a caller that needs a directory must never be told its answer was unrecognized, got %q", again.Body)
	}
	if getCheckoutAssignment("", 970801).Pending != raised {
		t.Fatal("the open choice must survive untouched")
	}

	// The overlay's own answer is the one thing that resolves it.
	dir, decision2, ok2 := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970801, optKeepSeparate, "feature/x")
	if decision2 != nil {
		t.Fatalf("unexpected further decision after answering: %+v", decision2)
	}
	if !ok2 || dir != checkout {
		t.Fatalf("expected the checkout to resolve after answering, dir=%q ok=%v", dir, ok2)
	}
	if checkoutChoiceOpen("", 970801) {
		t.Fatal("the choice must be closed after it was answered")
	}
}

// The checkout-menu chip answers a pending decision through its own
// conversationID == "" round trip (workflows.go's checkoutAnswer Activity) —
// that path must keep working regardless of which conversation (if any)
// raised the decision.
func TestPrepareChatShellWorkDirMenuAnswerBypassesOwnership(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970802, "", "feature/x")
	if ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected conv-z to raise a dirtyTree decision, got ok=%v decision=%+v", ok, decision)
	}

	dir, decision2, ok2 := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970802, optKeepSeparate, "feature/x")
	if decision2 != nil {
		t.Fatalf("unexpected further decision via the menu path: %+v", decision2)
	}
	if !ok2 || dir != checkout {
		t.Fatalf("expected the menu's own conversationID==\"\" round trip to resolve conv-z's decision, dir=%q ok=%v", dir, ok2)
	}
}

// A free-text reply that means "los laten" ("gewoon ernaast doen", never
// clicking the exact "Los laten (buiten Claude's commit houden)" button)
// must resolve exactly like the canonical option text — the reported bug:
// this kept coming back as "Dat antwoord herkende ik niet als een van de
// keuzes", forever.
func TestPrepareChatShellWorkDirRecognizesNaturalLanguageKeepSeparateReply(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1004, "", "feature/x")
	if ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a dirtyTree decision, got ok=%v decision=%+v", ok, decision)
	}

	dir, decision2, ok2 := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1004, "gewoon ernaast doen", "feature/x")
	if decision2 != nil {
		t.Fatalf("unexpected further decision: %+v", decision2)
	}
	if !ok2 || dir != checkout {
		t.Fatalf("expected the checkout ready after a natural-language 'los laten' reply, dir=%q ok=%v", dir, ok2)
	}
	if got, _ := os.ReadFile(filepath.Join(checkout, "foo.txt")); string(got) != "reviewer's own WIP\n" {
		t.Fatalf("'los laten' must not touch the working tree, got %q", got)
	}
}

// The reviewer choosing "Verwijderen" actually discards the pre-existing
// change, after which the checkout resolves cleanly.
func TestPrepareChatShellWorkDirDiscardOnRequest(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1004, "", "feature/x"); ok {
		t.Fatal("expected the dirty checkout to need a decision first")
	}

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1004, optDiscard, "feature/x")
	if decision != nil || !ok || dir != checkout {
		t.Fatalf("expected the checkout ready after discarding, dir=%q decision=%+v ok=%v", dir, decision, ok)
	}
	if got, _ := os.ReadFile(filepath.Join(checkout, "foo.txt")); string(got) != "v1\n" {
		t.Fatalf("expected the pre-existing change discarded, got %q", got)
	}
}

// Several equally valid candidates always require the reviewer to choose —
// even once, never an automatic pick.
func TestPrepareChatShellWorkDirAsksWhenMultipleCandidates(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	c1 := cloneCheckoutDir(t, bareDir, "feature/x")
	c2 := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, c1, c2)

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1005, "", "feature/x")
	if ok || dir != "" {
		t.Fatalf("expected no automatic pick among 2 candidates, got dir=%q ok=%v", dir, ok)
	}
	if decision == nil || decision.Stage != checkoutStageChooseDirectory {
		t.Fatalf("expected a chooseDirectory decision, got %+v", decision)
	}
	if len(decision.Options) != 2 {
		t.Fatalf("expected 2 options, got %v", decision.Options)
	}

	dir2, decision2, ok2 := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1005, c2, "feature/x")
	if decision2 != nil || !ok2 || dir2 != c2 {
		t.Fatalf("expected the chosen candidate %q ready, got dir=%q decision=%+v ok=%v", c2, dir2, decision2, ok2)
	}
}

// selectCheckoutCandidate is a pure function — no git needed at all — so its
// own decision logic (none/one/many) is tested directly.
func TestSelectCheckoutCandidate(t *testing.T) {
	if dir, dec := selectCheckoutCandidate(nil); dir != "" || dec != nil {
		t.Fatalf("no candidates: got dir=%q dec=%+v, want both empty", dir, dec)
	}
	one := []checkoutCandidate{{Dir: "/a"}}
	if dir, dec := selectCheckoutCandidate(one); dir != "/a" || dec != nil {
		t.Fatalf("one candidate: got dir=%q dec=%+v, want auto-pick", dir, dec)
	}
	many := []checkoutCandidate{{Dir: "/a"}, {Dir: "/b"}}
	dir, dec := selectCheckoutCandidate(many)
	if dir != "" || dec == nil || dec.Stage != checkoutStageChooseDirectory {
		t.Fatalf("multiple candidates: got dir=%q dec=%+v, want a chooseDirectory decision", dir, dec)
	}
	if len(dec.Options) != 2 || dec.Options[0] != "/a" || dec.Options[1] != "/b" {
		t.Fatalf("unexpected options: %v", dec.Options)
	}
}

// A directory already on the PR's own branch always wins over one that is
// merely on some other, already-merged (hence free) branch — reviewer
// decision: "...-3 is al op die branch, gebruik die, de andere staat op
// master/develop en die mag pas meedoen als er niet al een dir is die de
// branch al heeft". selectCheckoutCandidate narrows via
// prioritizeOnTargetBranch before deciding none/one/many, so a single
// on-target candidate auto-picks even while a merged-base one also exists,
// and several on-target candidates are offered WITHOUT the merged-base one
// mixed in.
func TestSelectCheckoutCandidatePrioritizesOnTargetBranch(t *testing.T) {
	onTarget := checkoutCandidate{Dir: "/on-target", OnTargetBranch: true}
	mergedBase := checkoutCandidate{Dir: "/merged-base", MergedIntoBase: true}

	// One on-target + one merged-base: auto-pick the on-target one, no
	// question at all — this is exactly the screenshot's reported case.
	dir, dec := selectCheckoutCandidate([]checkoutCandidate{onTarget, mergedBase})
	if dir != onTarget.Dir || dec != nil {
		t.Fatalf("expected the on-target candidate auto-picked, got dir=%q dec=%+v", dir, dec)
	}

	// Two on-target + one merged-base: choose only between the on-target
	// ones, never offering the merged-base directory alongside them.
	onTarget2 := checkoutCandidate{Dir: "/on-target-2", OnTargetBranch: true}
	dir, dec = selectCheckoutCandidate([]checkoutCandidate{onTarget, onTarget2, mergedBase})
	if dir != "" || dec == nil || dec.Stage != checkoutStageChooseDirectory {
		t.Fatalf("expected a chooseDirectory decision among the on-target candidates, got dir=%q dec=%+v", dir, dec)
	}
	if len(dec.Options) != 2 || dec.Options[0] != onTarget.Dir || dec.Options[1] != onTarget2.Dir {
		t.Fatalf("expected only the on-target candidates offered, got %v", dec.Options)
	}

	// No candidate on the target branch at all: the merged-base candidate
	// still participates exactly as before this change.
	dir, dec = selectCheckoutCandidate([]checkoutCandidate{mergedBase})
	if dir != mergedBase.Dir || dec != nil {
		t.Fatalf("expected the merged-base candidate auto-picked when nothing is on-target, got dir=%q dec=%+v", dir, dec)
	}
}

// listAllCheckoutChoices ("andere directory kiezen") is deliberately NOT
// narrowed by prioritizeOnTargetBranch — the reviewer asking for that menu is
// explicitly choosing to override the automatic pick, so it must keep
// offering every eligible candidate, including a merged-base one alongside an
// on-target one.
func TestListAllCheckoutChoicesDoesNotPrioritize(t *testing.T) {
	onTarget := checkoutCandidate{Dir: "/on-target", OnTargetBranch: true}
	mergedBase := checkoutCandidate{Dir: "/merged-base", MergedIntoBase: true}
	dec := listAllCheckoutChoices([]checkoutCandidate{onTarget, mergedBase})
	if dec == nil || len(dec.Options) != 2 {
		t.Fatalf("expected both candidates offered unfiltered, got %+v", dec)
	}
}

func TestRepoSlugFromRemoteURL(t *testing.T) {
	cases := map[string]string{
		"https://github.com/plug-and-pay/plug-and-pay":     "plug-and-pay/plug-and-pay",
		"https://github.com/plug-and-pay/plug-and-pay.git": "plug-and-pay/plug-and-pay",
		"git@github.com:plug-and-pay/plug-and-pay.git":     "plug-and-pay/plug-and-pay",
		"git@github.com:Plug-And-Pay/Plug-And-Pay.git":     "plug-and-pay/plug-and-pay",
		"https://gitlab.com/plug-and-pay/plug-and-pay.git": "",
		"": "",
	}
	for in, want := range cases {
		if got := repoSlugFromRemoteURL(in); got != want {
			t.Fatalf("repoSlugFromRemoteURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// A fork (same repo name, different owner) is never a candidate at all — the
// exact-slug rule, no exceptions.
func TestCheckoutRemoteMatchesSlugRejectsFork(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	fork := cloneCheckoutDir(t, bareDir, "feature/x")
	// Override BOTH remotes cloneCheckoutDir sets up to look like a DIFFERENT
	// owner of the same repo name — exactly what a real fork's remote would
	// look like. No remote of this checkout may match the configured slug.
	for _, name := range []string{"origin", "slug-tag"} {
		if out, err := exec.Command("git", "-C", fork, "remote", "set-url", name, "https://github.com/someone-else/plug-and-pay.git").CombinedOutput(); err != nil {
			t.Fatalf("remote set-url %s: %v: %s", name, err, out)
		}
	}
	writeCheckoutSettings(t, dataDir, fork)

	if checkoutRemoteMatchesSlug(ctx, fork, repoSlug) {
		t.Fatal("a fork's remote must never match the repo slug")
	}
	_, _, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1006, "", "feature/x")
	if ok {
		t.Fatal("expected no candidate at all when the only registered directory is a fork")
	}
}

func TestCheckoutLocalPendingStateDetectsDirtyAndAhead(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	ctx := context.Background()
	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, "", 1007, dir)

	if exists, dirty, ahead, _ := checkoutLocalPendingState(ctx, "", 1007); !exists || dirty || ahead != 0 {
		t.Fatalf("clean checkout reported exists=%v dirty=%v ahead=%d, want true/false/0", exists, dirty, ahead)
	}

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("claude was here\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, dirty, _, _ := checkoutLocalPendingState(ctx, "", 1007); !dirty {
		t.Fatal("expected dirty=true for an uncommitted edit")
	}

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("add", "-A")
	run("commit", "-m", "local only")
	if _, dirty, ahead, _ := checkoutLocalPendingState(ctx, "", 1007); dirty || ahead != 1 {
		t.Fatalf("committed-but-unlanded checkout reported dirty=%v ahead=%d, want false/1", dirty, ahead)
	}
}

// A successful "commit deze wijziging" LANDS on the PR's local pending ref and
// deliberately does NOT push, and the checkout itself is never removed —
// unlike the old disposable shadow worktree, this is the reviewer's own,
// permanent clone.
func TestCommitCheckoutEditsLandsOnPendingRefWithoutPushingOrRemovingTheCheckout(t *testing.T) {
	bareDir, cloneDir := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, "", 1008, dir)
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 1008, "conv-g", "turn-conv-g", "feature/x")
	if msg.Kind == chat.KindError {
		t.Fatalf("commit reported an error: %+v", msg)
	}

	ref := prPendingRef("", 1008, "feature/x")
	sha := pendingRefSHA(ctx, "", ref)
	if sha == "" {
		t.Fatalf("pending ref %s does not exist after a successful landing", ref)
	}
	out, err := exec.Command("git", "-C", cloneDir, "show", sha+":foo.txt").Output()
	if err != nil || string(out) != "edited by claude\n" {
		t.Fatalf("pending ref content = %q, err %v; want the edit", out, err)
	}

	// ...and the remote is deliberately untouched: no push happened.
	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	if got, _ := os.ReadFile(filepath.Join(verify, "foo.txt")); string(got) != "v1\n" {
		t.Fatalf("remote content = %q, want v1 (landing must not push)", got)
	}

	// The checkout itself is never removed.
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("expected the checkout to remain on disk, stat err = %v", err)
	}
}

func TestCommitCheckoutEditsRefusesNonFastForward(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, "", 1009, dir)
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Someone else pushes to the real branch AFTER the checkout was cloned but
	// BEFORE the reviewer asks to commit — the classic conflict this feature
	// must never silently force through.
	pushToBare(t, bareDir, "feature/x", "someone else's commit\n")

	msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 1009, "conv-h", "turn-conv-h", "feature/x")
	if msg.Kind != chat.KindError {
		t.Fatalf("expected an error message on a non-fast-forward landing, got: %+v", msg)
	}
	if sha := pendingRefSHA(ctx, "", prPendingRef("", 1009, "feature/x")); sha != "" {
		t.Fatalf("pending ref was created for a refused landing: %s", sha)
	}

	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	got, err := os.ReadFile(filepath.Join(verify, "foo.txt"))
	if err != nil || string(got) != "someone else's commit\n" {
		t.Fatalf("bare repo content = %q, err %v; want it untouched by the refused push", got, err)
	}
}

func TestCommitCheckoutEditsNothingToCommit(t *testing.T) {
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	// No assignment at all — no checkout was ever resolved for this PR.
	msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 1010, "conv-i", "turn-conv-i", "feature/x")
	if msg.Kind != chat.KindError {
		t.Fatalf("expected an informational error when nothing is assigned, got: %+v", msg)
	}
}

// A second landing on the same PR, before the first has been pushed, folds
// into the first commit via `git commit --amend` instead of stacking a new
// one — PR-wide, so a different conversation's earlier landing still counts.
// See .claude/docs/pending-push.md, "Amending a chain of chat commits".
func TestCommitCheckoutEditsAmendsIntoPreviousUnpushedChatCommit(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, "", 1020, dir)

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edit one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 1020, "conv-first", "turn-1", "feature/x"); msg.Kind == chat.KindError {
		t.Fatalf("first landing reported an error: %+v", msg)
	}
	firstSHA := pendingRefSHA(ctx, "", prPendingRef("", 1020, "feature/x"))
	if firstSHA == "" {
		t.Fatal("expected a pending ref after the first landing")
	}

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edit two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A different conversation of the same PR — the amend is PR-wide.
	if msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 1020, "conv-second", "turn-2", "feature/x"); msg.Kind == chat.KindError {
		t.Fatalf("second landing reported an error: %+v", msg)
	}
	secondSHA := pendingRefSHA(ctx, "", prPendingRef("", 1020, "feature/x"))
	if secondSHA == "" || secondSHA == firstSHA {
		t.Fatalf("expected the pending ref to follow the new (amended) sha, got %s (was %s)", secondSHA, firstSHA)
	}

	aheadOut, err := exec.Command("git", "-C", dir, "rev-list", "--count", "origin/feature/x..HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("rev-list: %v: %s", err, aheadOut)
	}
	if got := strings.TrimSpace(string(aheadOut)); got != "1" {
		t.Fatalf("expected exactly ONE commit ahead of origin after amending, got %s", got)
	}

	bodyOut, err := exec.Command("git", "-C", dir, "log", "-1", "--format=%B", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("log: %v: %s", err, bodyOut)
	}
	body := string(bodyOut)
	if !strings.Contains(body, "conv-first") || !strings.Contains(body, "conv-second") {
		t.Fatalf("expected the amended commit message to carry both conversation ids, got: %s", body)
	}
}

// Once a chat commit has actually been pushed, a further edit must create a
// NEW commit, never amend the already-pushed one — the hard "not yet pushed"
// safety check.
func TestCommitCheckoutEditsDoesNotAmendAfterAPush(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, "", 1021, dir)

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edit one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 1021, "conv-a", "turn-a", "feature/x"); msg.Kind == chat.KindError {
		t.Fatalf("first landing reported an error: %+v", msg)
	}

	// The reviewer pushes via the todo row — simulated directly here, this
	// test is about commitCheckoutEditsAt's own amend decision, not the push
	// path itself (see pending_push_test.go for that).
	if out, err := exec.Command("git", "-C", dir, "push", "origin", "feature/x").CombinedOutput(); err != nil {
		t.Fatalf("push: %v: %s", err, out)
	}

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edit two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 1021, "conv-b", "turn-b", "feature/x"); msg.Kind == chat.KindError {
		t.Fatalf("second landing reported an error: %+v", msg)
	}

	aheadOut, err := exec.Command("git", "-C", dir, "rev-list", "--count", "origin/feature/x..HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("rev-list: %v: %s", err, aheadOut)
	}
	if got := strings.TrimSpace(string(aheadOut)); got != "1" {
		t.Fatalf("expected exactly one NEW commit (not amended) after a push, got %s ahead of origin", got)
	}
	bodyOut, _ := exec.Command("git", "-C", dir, "log", "-1", "--format=%B", "HEAD").CombinedOutput()
	if strings.Contains(string(bodyOut), "conv-a") {
		t.Fatalf("must never rewrite an already-pushed commit, message = %s", bodyOut)
	}
}

// A merge commit — even one carrying the exact chat-edit subject line — must
// never be amended: only its parent count decides this, not the subject.
func TestAmendableChatCommitRejectsAMergeCommit(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	ctx := context.Background()
	dir := cloneCheckoutDir(t, bareDir, "feature/x")

	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("checkout", "-b", "side")
	if err := os.WriteFile(filepath.Join(dir, "bar.txt"), []byte("side\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "side change")
	run("checkout", "feature/x")
	if err := os.WriteFile(filepath.Join(dir, "baz.txt"), []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "main change")
	run("merge", "side", "--no-ff", "-m", chatEditCommitSubject)

	if _, ok := amendableChatCommit(ctx, dir, "feature/x"); ok {
		t.Fatal("a merge commit must never be reported as amendable, regardless of its subject")
	}
}

// A reviewer's own manual commit in the same shared checkout — with a
// different subject line — must never be mistaken for a chat commit.
func TestAmendableChatCommitRejectsAManualCommit(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	ctx := context.Background()
	dir := cloneCheckoutDir(t, bareDir, "feature/x")

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("manual edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("add", "-A")
	run("commit", "-m", "reviewer's own unrelated fix")

	if _, ok := amendableChatCommit(ctx, dir, "feature/x"); ok {
		t.Fatal("a manual, non-chat commit must never be reported as amendable")
	}
}

// testChatModule returns a throwaway chat.Module backed by an in-memory-ish
// SQLite file under t.TempDir(), for tests that need commitCheckoutEditsAt's
// message-saving side effect but don't care about its content.
func testChatModule(t *testing.T) *chat.Module {
	t.Helper()
	cm, err := chat.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatalf("open chat module: %v", err)
	}
	t.Cleanup(func() { _ = cm.Close() })
	return cm
}

// TestFastForwardCheckoutToOriginSurvivesBrokenSubmodule reproduces the
// production incident documented in .claude/docs/workflows-comments.md
// ("Agentic edits") against the NEW checkout-based path (mirrors the retired
// TestEnsureChatShadowWorktreeRefreshSurvivesBrokenSubmodule): a real,
// committed submodule whose URL cannot be resolved, combined with
// submodule.recurse=true, makes an ORDINARY `merge`/`checkout` that has to
// move the submodule's recorded commit try to (re)initialize its gitdir,
// fail partway, and leave the checkout permanently wedged. Every mutating
// git call in chat_checkout.go carries `-c submodule.recurse=false` for
// exactly this reason; this test proves that guard actually works, not just
// that it's present in the source.
func TestFastForwardCheckoutToOriginSurvivesBrokenSubmodule(t *testing.T) {
	run := func(dir string, args ...string) []byte {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
		}
		return out
	}

	root := t.TempDir()
	subBare := filepath.Join(root, "sub.git")
	if out, err := exec.Command("git", "init", "--bare", subBare).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare sub: %v: %s", err, out)
	}
	subSeed := filepath.Join(root, "sub-seed")
	if err := os.MkdirAll(subSeed, 0o755); err != nil {
		t.Fatal(err)
	}
	run(subSeed, "init")
	run(subSeed, "config", "user.email", "test@example.com")
	run(subSeed, "config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(subSeed, "sub.txt"), []byte("sub\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(subSeed, "add", "sub.txt")
	run(subSeed, "commit", "-m", "sub seed")
	run(subSeed, "remote", "add", "origin", subBare)
	run(subSeed, "push", "origin", "HEAD:master")

	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	// The submodule is added on top of setupChatShadowRepo's own seed commit,
	// pushed as a further commit on the same branch via a throwaway clone —
	// the shared clone stays untouched until the SHA it fetches already
	// contains the submodule.
	seed2 := filepath.Join(root, "seed2")
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, seed2).CombinedOutput(); err != nil {
		t.Fatalf("clone to add submodule: %v: %s", err, out)
	}
	run(seed2, "config", "user.email", "test@example.com")
	run(seed2, "config", "user.name", "test")
	run(seed2, "-c", "protocol.file.allow=always", "submodule", "add", subBare, "forks/nova")
	run(seed2, "commit", "-m", "add submodule")
	// Break the URL to something no clone/init can ever resolve — the gitlink
	// SHA already committed above stays valid regardless of the URL.
	gitmodules, err := os.ReadFile(filepath.Join(seed2, ".gitmodules"))
	if err != nil {
		t.Fatal(err)
	}
	broken := strings.ReplaceAll(string(gitmodules), subBare, "/nonexistent/sub.git")
	if err := os.WriteFile(filepath.Join(seed2, ".gitmodules"), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	run(seed2, "add", ".gitmodules")
	run(seed2, "commit", "-m", "break submodule url")
	run(seed2, "push", "origin", "feature/x")

	// The reviewer's checkout is cloned BEFORE this commit lands, so a later
	// fast-forward is the one that has to bring the submodule in.
	ctx := context.Background()
	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	run(dir, "reset", "--hard", "HEAD^") // back to the pre-submodule commit
	run(dir, "config", "submodule.recurse", "true")
	run(dir, "config", "submodule.forks/nova.active", "true")

	pushToBare(t, bareDir, "feature/x", "v2\n") // an unrelated further commit, on top

	// Sanity check the fixture itself on a SEPARATE clone (never the real dir
	// under test, so a failed plain attempt can't contaminate it with an
	// unrelated half-applied working-tree change): an ordinary `git fetch` +
	// `git reset --hard` (no protective flag; the exact command the original
	// production incident traced to) must fail with the production symptom.
	sanity := cloneCheckoutDir(t, bareDir, "feature/x")
	run(sanity, "reset", "--hard", "HEAD^")
	run(sanity, "config", "submodule.recurse", "true")
	run(sanity, "config", "submodule.forks/nova.active", "true")
	run(sanity, "fetch", "origin", "feature/x")
	if out, err := exec.Command("git", "-C", sanity, "reset", "--hard", "origin/feature/x").CombinedOutput(); err == nil {
		t.Fatalf("expected the broken submodule to break a plain reset --hard, it didn't: %s", out)
	} else if !strings.Contains(string(out), "could not reset submodule index") && !strings.Contains(string(out), "Could not access submodule") && !strings.Contains(string(out), "not a git repository") {
		t.Fatalf("fixture did not reproduce the expected submodule failure, got: %s", out)
	}

	// The actual assertion, against the UNTOUCHED dir: fastForwardCheckoutToOrigin
	// must succeed despite the broken submodule.
	if err := fastForwardCheckoutToOrigin(ctx, dir, "feature/x"); err != nil {
		t.Fatalf("fast-forward with a broken submodule: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "foo.txt")); string(got) != "v2\n" {
		t.Fatalf("checkout content after fast-forward = %q, want v2\\n", got)
	}
}

// listAllCheckoutChoices is pure — no git needed — and, unlike
// selectCheckoutCandidate, never auto-picks even for a single candidate.
func TestListAllCheckoutChoicesNeverAutoPicks(t *testing.T) {
	if dec := listAllCheckoutChoices(nil); dec == nil || len(dec.Options) != 0 || dec.Body == "" {
		t.Fatalf("zero candidates: got %+v, want a decision with an explanatory body and no options", dec)
	}
	one := []checkoutCandidate{{Dir: "/a"}}
	dec := listAllCheckoutChoices(one)
	if dec == nil || dec.Stage != checkoutStageChooseDirectory || len(dec.Options) != 1 || dec.Options[0] != "/a" {
		t.Fatalf("one candidate: got %+v, want it still offered as a choice, not auto-picked", dec)
	}
	many := []checkoutCandidate{{Dir: "/a"}, {Dir: "/b"}}
	dec = listAllCheckoutChoices(many)
	if dec == nil || len(dec.Options) != 2 {
		t.Fatalf("two candidates: got %+v", dec)
	}
}

// relistCheckoutCandidates ("andere directory kiezen") is a clean slate: an
// earlier explicit rejection (Excluded) of a candidate must be offered again.
func TestRelistCheckoutCandidatesClearsExclusions(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	stubReachableGh(t, "feature/x")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	a := getOrCreateCheckoutAssignment("", 1011)
	a.Excluded[checkout] = true

	dec := relistCheckoutCandidates(ctx, nil, dataDir, "", 1011)
	if dec == nil || len(dec.Options) != 1 || dec.Options[0] != checkout {
		t.Fatalf("expected the previously-excluded candidate to be offered again, got %+v", dec)
	}
	if a.Pending == nil {
		t.Fatal("expected the relisted decision to be stored as the PR's pending decision")
	}
	if len(a.Excluded) != 0 {
		t.Fatalf("expected exclusions to be cleared by an explicit relist, got %v", a.Excluded)
	}
}

// relistCheckoutCandidates with zero candidates does NOT persist a pending
// decision — so a directory becoming available later starts completely
// fresh rather than being stuck on an empty, un-answerable one.
func TestRelistCheckoutCandidatesNoCandidatesLeavesNothingPending(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	stubReachableGh(t, "feature/x")
	dataDir := t.TempDir()
	ctx := context.Background()
	// No chatCheckoutDirs configured, and the home-dir-scan fallback is
	// isolated to an empty throwaway directory (SLASH_CHECKOUT_HOME_DIR) so
	// this genuinely exercises the zero-candidate path regardless of what
	// real checkouts exist on the machine running this test.
	t.Setenv("SLASH_CHECKOUT_HOME_DIR", t.TempDir())
	dec := relistCheckoutCandidates(ctx, nil, dataDir, "", 1012)
	if dec == nil || len(dec.Options) != 0 {
		t.Fatalf("expected an explanatory, option-less decision, got %+v", dec)
	}
	a := getOrCreateCheckoutAssignment("", 1012)
	if a.Pending != nil {
		t.Fatalf("expected nothing persisted as pending, got %+v", a.Pending)
	}
}

func TestCheckoutSetOffClearsAssignmentButKeepsStashBookkeeping(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	a := getOrCreateCheckoutAssignment("", 1013)
	a.Dir = dir
	a.Branch = "feature/x"
	a.Excluded["/somewhere"] = true
	a.StashRef = "slash-chat-x"
	a.StashDir = dir

	checkoutSetOff("", 1013)

	if a.Dir != "" || a.Branch != "" || a.Pending != nil || len(a.Excluded) != 0 {
		t.Fatalf("expected the assignment cleared, got dir=%q branch=%q pending=%+v excluded=%v", a.Dir, a.Branch, a.Pending, a.Excluded)
	}
	if a.StashRef == "" || a.StashDir == "" {
		t.Fatal("expected stash bookkeeping to survive 'uit', so 'nu terugzetten' still works")
	}
}

func TestCheckoutRestoreStashNowPopsOnDemand(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	ctx := context.Background()
	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := stashCheckoutDirty(ctx, dir, "slash-chat-test-1014"); err != nil {
		t.Fatalf("stash: %v", err)
	}
	a := getOrCreateCheckoutAssignment("", 1014)
	a.StashRef = "slash-chat-test-1014"
	a.StashDir = dir

	if err := checkoutRestoreStashNow(ctx, "", 1014); err != nil {
		t.Fatalf("restore stash now: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "foo.txt")); string(got) != "reviewer's own WIP\n" {
		t.Fatalf("expected the stashed change restored, got %q", got)
	}
	if a.StashRef != "" || a.StashDir != "" {
		t.Fatalf("expected stash bookkeeping cleared after restoring, got StashRef=%q StashDir=%q", a.StashRef, a.StashDir)
	}

	// A no-op, not an error, when nothing is pending.
	if err := checkoutRestoreStashNow(ctx, "", 1014); err != nil {
		t.Fatalf("restore with nothing pending should be a no-op, got: %v", err)
	}
}

func TestBuildCheckoutViewShapes(t *testing.T) {
	empty := buildCheckoutView("", 1015)
	if empty.Dir != "" || empty.Decision != nil || empty.StashPending {
		t.Fatalf("expected an empty view for a PR with no checkout activity, got %+v", empty)
	}
	if empty.RunID == "" {
		t.Fatal("expected RunID to always be present (a deterministic string), even with nothing assigned")
	}

	a := getOrCreateCheckoutAssignment("", 1016)
	a.Dir = "/home/reindert/dev/plug-and-pay-2"
	a.Branch = "feature/x"
	a.StashRef = "slash-chat-y"
	view := buildCheckoutView("", 1016)
	if view.Dir != a.Dir || view.DirName != "plug-and-pay-2" || view.Branch != "feature/x" || !view.StashPending {
		t.Fatalf("unexpected view: %+v", view)
	}
}

// checkoutView.PendingFiles mirrors chat_edit_pending.go's own registry —
// the review tree's "wordt aangepast" pill reads it straight off the same
// read model the checkout chip already polls.
func TestBuildCheckoutViewReportsPendingFiles(t *testing.T) {
	defer clearChatPendingFiles("", 1017)

	empty := buildCheckoutView("", 1017)
	if len(empty.PendingFiles) != 0 {
		t.Fatalf("expected no pending files yet, got %v", empty.PendingFiles)
	}

	markChatFilesPending("", 1017, []string{"src/Foo.php", "src/Bar.php"})
	view := buildCheckoutView("", 1017)
	if len(view.PendingFiles) != 2 || view.PendingFiles[0] != "src/Bar.php" || view.PendingFiles[1] != "src/Foo.php" {
		t.Fatalf("PendingFiles = %v, want the marked files sorted", view.PendingFiles)
	}

	clearChatPendingFiles("", 1017)
	view = buildCheckoutView("", 1017)
	if len(view.PendingFiles) != 0 {
		t.Fatalf("expected PendingFiles cleared, got %v", view.PendingFiles)
	}
}

// checkoutView.RefreshingFiles mirrors chat_refresh_pending.go's own
// registry — the review tree's "wordt bijgewerkt" pill (and home.mjs's
// blocks.changed handler telling its own landing apart from a colleague's
// push) reads it straight off the same read model the checkout chip already
// polls. See .claude/docs/pending-push.md.
func TestBuildCheckoutViewReportsRefreshingFiles(t *testing.T) {
	defer clearChatRefreshPendingFiles("", 1018)

	empty := buildCheckoutView("", 1018)
	if len(empty.RefreshingFiles) != 0 {
		t.Fatalf("expected no refreshing files yet, got %v", empty.RefreshingFiles)
	}

	markChatRefreshPendingFiles("", 1018, []string{"src/Foo.php", "src/Bar.php"})
	view := buildCheckoutView("", 1018)
	if len(view.RefreshingFiles) != 2 || view.RefreshingFiles[0] != "src/Bar.php" || view.RefreshingFiles[1] != "src/Foo.php" {
		t.Fatalf("RefreshingFiles = %v, want the marked files sorted", view.RefreshingFiles)
	}

	clearChatRefreshPendingFiles("", 1018)
	view = buildCheckoutView("", 1018)
	if len(view.RefreshingFiles) != 0 {
		t.Fatalf("expected RefreshingFiles cleared, got %v", view.RefreshingFiles)
	}
}

// TestChatCheckoutNeedsLandingStopsAfterALandedCommit is the regression for a
// reviewer report: a pure question turn (no edit at all) triggered the
// "Wijziging staat op ..." auto-land notice again, on a PR whose checkout had
// already landed a commit earlier in the conversation. chatCheckoutNeedsLanding
// used to compare HEAD only against `--not --remotes`, which stays true FOREVER
// once a commit has landed on the PR's own local pending ref (that ref is never
// itself a remote, and landing never pushes to GitHub) — so every later turn,
// including one that never touched the checkout, kept reporting "needs
// landing". The fix compares HEAD against the pending ref's own SHA once it
// exists, so a commit already reflected there stops being reported as
// outstanding.
func TestChatCheckoutNeedsLandingStopsAfterALandedCommit(t *testing.T) {
	const headRefName = "feature/needslanding"
	bareDir, _ := setupChatShadowRepo(t, headRefName, "v1\n")
	ctx := context.Background()
	const pr = 970741

	checkout := cloneCheckoutDir(t, bareDir, headRefName)
	assignCheckoutForTest(t, "", pr, checkout)
	getOrCreateCheckoutAssignment("", pr).Branch = headRefName

	if chatCheckoutNeedsLanding(ctx, "", pr) {
		t.Fatal("a freshly cloned, unedited checkout should not need landing")
	}

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", checkout}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("add", "-A")
	run("commit", "-m", "Claude: reviewer-requested edit")

	if !chatCheckoutNeedsLanding(ctx, "", pr) {
		t.Fatal("a real, never-landed local commit should need landing")
	}

	// Simulate the actual landing plumbing (advancePendingRefFromCheckout,
	// chat_checkout.go) without going through a whole Claude turn.
	if err := advancePendingRefFromCheckout(ctx, checkout, "", pr, headRefName, false); err != nil {
		t.Fatalf("advancePendingRefFromCheckout: %v", err)
	}

	if chatCheckoutNeedsLanding(ctx, "", pr) {
		t.Fatal("a commit already mirrored onto the PR's pending ref must not be reported as needing landing again — this is the reported bug")
	}
}
