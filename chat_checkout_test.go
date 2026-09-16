package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"slash/modules/chat"
	"slash/modules/claude"
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
	// Every fixture gets a fresh clone/origin pair, so any memoized remote head
	// from an earlier test (remoteHeadSHA, pending_push.go) is about a repo that
	// no longer exists — and its key (repo + PR number) can legitimately repeat.
	remoteHeadCache.Lock()
	remoteHeadCache.byPR = map[prKey]remoteHeadEntry{}
	remoteHeadCache.Unlock()
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
	getOrCreateCheckoutAssignment("", repo, pr).Dir = dir
}

// assignPendingDecisionForTest registers this PR's pending work-directory
// choice directly — skipping the discovery ladder — for the end-to-end
// regression test (chat_workflow_test.go) proving an ordinary, read-only chat
// turn never even touches it.
func assignPendingDecisionForTest(t *testing.T, repo string, pr int, decision *chatCheckoutDecision) {
	t.Helper()
	getOrCreateCheckoutAssignment("", repo, pr).Pending = decision
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

// resetInMemoryCheckoutAssignments simulates a server restart: the process-
// global chatCheckoutByPR map (chat_checkout.go) is gone, but nothing on disk
// (the git checkout, or the durable chat_checkout.db mirror) is touched.
func resetInMemoryCheckoutAssignments(t *testing.T) {
	t.Helper()
	chatCheckoutMu.Lock()
	chatCheckoutByPR = map[prKey]*chatCheckoutAssignment{}
	chatCheckoutMu.Unlock()
}

// A restart must not lose which directory a PR was already using — the
// reported bug: GET /api/chat/checkout came back with no dir/dirName for a
// PR whose chat had long since shown landed edits, because the in-memory
// chatCheckoutByPR map (the only thing buildCheckoutView read) is empty right
// after a restart. This drives the exact same fix at the level the bug was
// actually reported: prepareChatShellWorkDirAt itself must resolve to the
// SAME directory a second time, from the durable mirror alone, without
// re-running the discovery ladder (proven by removing the settings.json entry
// discovery depends on before the "restart").
func TestPrepareChatShellWorkDirSurvivesARestart(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "hello\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1050, "", "feature/x")
	if decision != nil {
		t.Fatalf("unexpected decision: %+v", decision)
	}
	if !ok || dir != checkout {
		t.Fatalf("first resolve: dir=%q ok=%v, want %q true", dir, ok, checkout)
	}

	// Simulate the restart, and remove the ONLY way the ladder could otherwise
	// rediscover this checkout (the settings.json registration) — if the
	// persisted dir is not picked up, this PR now has no candidate at all.
	resetInMemoryCheckoutAssignments(t)
	writeCheckoutSettings(t, dataDir /* no dirs */)

	dir2, decision2, ok2 := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1050, "", "feature/x")
	if decision2 != nil {
		t.Fatalf("unexpected decision after restart: %+v", decision2)
	}
	if !ok2 {
		t.Fatal("second resolve after restart: expected ok, the persisted dir should have been reused")
	}
	if dir2 != checkout {
		t.Fatalf("dir after restart = %q, want %q", dir2, checkout)
	}
}

// The read-only side of the same fix: buildCheckoutView (GET
// /api/chat/checkout's read model) must show the persisted dir/branch right
// after a restart too, even before any write turn re-touches this PR.
func TestBuildCheckoutViewSurvivesARestart(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "hello\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if _, _, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1051, "", "feature/x"); !ok {
		t.Fatal("setup: expected a ready checkout")
	}

	resetInMemoryCheckoutAssignments(t)

	view := buildCheckoutView(dataDir, "", 1051)
	if view.Dir != checkout {
		t.Fatalf("Dir after restart = %q, want %q", view.Dir, checkout)
	}
	if view.DirName != filepath.Base(checkout) {
		t.Fatalf("DirName after restart = %q, want %q", view.DirName, filepath.Base(checkout))
	}
	if view.Branch != "feature/x" {
		t.Fatalf("Branch after restart = %q, want %q", view.Branch, "feature/x")
	}
}

// A restart must also not resurrect a PR the reviewer explicitly turned off —
// checkoutSetOff's clear has to reach the durable mirror too, not just the
// in-memory assignment.
func TestCheckoutSetOffClearPersistsAcrossARestart(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "hello\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if _, _, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1052, "", "feature/x"); !ok {
		t.Fatal("setup: expected a ready checkout")
	}
	checkoutSetOff(dataDir, "", 1052)
	resetInMemoryCheckoutAssignments(t)

	view := buildCheckoutView(dataDir, "", 1052)
	if view.Dir != "" {
		t.Fatalf("Dir after restart following checkoutSetOff = %q, want empty", view.Dir)
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
	// The choice must NAME the files it is about — the reviewer used to
	// answer "Meenemen in de commit"/"Verwijderen" about changes he could not
	// see (see chatCheckoutDecision.Paths).
	if len(decision.Paths) != 1 || decision.Paths[0] != "foo.txt" {
		t.Fatalf("expected the dirty file listed on the decision, got %v", decision.Paths)
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

// A "dirty" tree that consists ENTIRELY of another conversation's own
// not-yet-landed edit is never put to the reviewer as a dirtyTree decision —
// it is not the reviewer's own unrelated work at all, just a turn whose
// commit hasn't reached this checkout yet (the write-turn slot is released
// before the automatic post-turn landing, chat_write_gate.go). Reported bug:
// two conversations on the same PR, one still landing its own edit while the
// other escalated to write, kept re-raising "er zijn niet-gerelateerde
// wijzigingen" forever.
func TestPrepareChatShellWorkDirSkipsDirtyDecisionForOwnPendingEdit(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	const repo, pr = "", 1004
	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("another conversation's own edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Records "foo.txt" as a known, not-yet-landed edit for this PR — exactly
	// what finishChatProgress (chat_progress.go) does right before a write
	// turn's own progress snapshot is cleared.
	markChatFilesPending(repo, pr, []string{"foo.txt"})
	t.Cleanup(func() { clearChatPendingFiles(repo, pr) })

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, repo, pr, "", "feature/x")
	if ok || dir != "" {
		t.Fatalf("expected the checkout not ready yet, got dir=%q ok=%v", dir, ok)
	}
	if decision != nil {
		t.Fatalf("expected NO decision for a dirty tree that is only another conversation's pending edit, got %+v", decision)
	}
	if checkoutChoiceOpen(dataDir, repo, pr) {
		t.Fatal("expected no open work-directory choice to be raised at all")
	}

	// An EXTRA, genuinely unrelated dirty file alongside the pending one still
	// raises the ordinary dirtyTree question — this must not silently wave
	// through real reviewer changes just because ONE other file happens to be
	// pending.
	if err := os.WriteFile(filepath.Join(checkout, "bar.txt"), []byte("reviewer's own unrelated WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir2, decision2, ok2 := prepareChatShellWorkDirAt(ctx, nil, dataDir, repo, pr, "", "feature/x")
	if ok2 || dir2 != "" {
		t.Fatalf("expected still not ready, got dir=%q ok=%v", dir2, ok2)
	}
	if decision2 == nil || decision2.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a dirtyTree decision once a genuinely unrelated file is also dirty, got %+v", decision2)
	}
}

// An open choice is put to the reviewer AGAIN on the next write turn, but
// only after checking that it is still a real question. Reported bug, in the
// reviewer's own words: "geef die keuze opnieuw als het nodig is, want alles
// is al gecommit" — he had committed the dirty tree himself, outside slash,
// and every following turn still refused with "Geen bestandstoegang: er staat
// nog een keuze open over de werkmap van deze PR". The stale dirtyTree choice
// must be dropped and the turn must simply carry on.
func TestPrepareChatShellWorkDirDropsAStaleDirtyChoice(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970804, "", "feature/x"); ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a dirtyTree decision first, got ok=%v decision=%+v", ok, decision)
	}

	// The reviewer resolves it himself, outside slash: he commits everything.
	commit := exec.Command("git", "-C", checkout, "commit", "-am", "reviewer committed his own WIP")
	if out, err := commit.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v: %s", err, out)
	}

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970804, "", "feature/x")
	if decision != nil {
		t.Fatalf("expected the stale dirtyTree choice to be gone, got %+v", decision)
	}
	if !ok || dir != checkout {
		t.Fatalf("expected the checkout ready right away, dir=%q ok=%v", dir, ok)
	}
	if checkoutChoiceOpen(dataDir, "", 970804) {
		t.Fatal("expected no open work-directory choice left, so the overlay/chip closes too")
	}
}

// The mirror image: a choice that IS still needed keeps being put to the
// reviewer, unchanged, on every following turn.
func TestPrepareChatShellWorkDirKeepsAStillNeededDirtyChoice(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970805, "", "feature/x"); ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a dirtyTree decision first, got ok=%v decision=%+v", ok, decision)
	}
	_, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970805, "", "feature/x")
	if ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected the same dirtyTree choice again, got ok=%v decision=%+v", ok, decision)
	}
	if !checkoutChoiceOpen(dataDir, "", 970805) {
		t.Fatal("expected the work-directory choice to stay open")
	}
}

// A dirty-tree choice that deliberately LEAVES the tree dirty ("Meenemen in
// de commit"/"Los laten") must stay resolved for every LATER turn too.
// Reported bug, two screenshots: the reviewer answered "Meenemen in de commit"
// in the werkmap overlay, asked Claude for a change ("retry"), and got
// "Ik kan nu geen code aanpassen: er staat nog een keuze open over de werkmap
// van deze PR" again — and the overlay reopened on the identical question,
// forever. Cause: chatCheckoutResolved.Final only skips re-classification
// inside the call that resolved the choice, so the next call re-classified the
// still-dirty directory and raised chatCheckoutDirtyDecision all over again.
func TestPrepareChatShellWorkDirKeepsAnAcceptedDirtyTreeResolved(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970803, "", "feature/x"); ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a dirtyTree decision first, got ok=%v decision=%+v", ok, decision)
	}
	if dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970803, optKeepCombined, "feature/x"); !ok || dir != checkout || decision != nil {
		t.Fatalf("expected the checkout ready after 'meenemen', dir=%q decision=%+v ok=%v", dir, decision, ok)
	}

	// The next turn (a write turn, comment_batch, test_run — all pass "")
	// must simply get the directory, with no open choice anywhere.
	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970803, "", "feature/x")
	if !ok || dir != checkout || decision != nil {
		t.Fatalf("expected the accepted dirty tree to stay resolved, dir=%q decision=%+v ok=%v", dir, decision, ok)
	}
	if checkoutChoiceOpen("", "", 970803) {
		t.Fatal("expected no open work-directory choice after 'meenemen'")
	}
	if got, _ := os.ReadFile(filepath.Join(checkout, "foo.txt")); string(got) != "reviewer's own WIP\n" {
		t.Fatalf("'meenemen' must not touch the working tree, got %q", got)
	}

	// A genuinely NEW, never-discussed change in the same directory DOES ask
	// again — the acceptance covers the paths it was given, not the directory
	// forever.
	if err := os.WriteFile(filepath.Join(checkout, "bar.txt"), []byte("something else entirely\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970803, "", "feature/x"); ok || decision == nil || decision.Stage != checkoutStageDirtyTree {
		t.Fatalf("expected a fresh dirtyTree decision for new dirty work, got ok=%v decision=%+v", ok, decision)
	}
}

// Same guarantee for "Los laten" — the other choice that leaves the tree
// dirty on purpose (and whose KeepSeparatePaths a landing clears, which is
// exactly why the acceptance is recorded separately).
func TestPrepareChatShellWorkDirKeepsKeepSeparateResolved(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)

	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("reviewer's own WIP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970804, "", "feature/x"); ok {
		t.Fatal("expected the dirty checkout to need a decision first")
	}
	if _, _, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970804, optKeepSeparate, "feature/x"); !ok {
		t.Fatal("expected the checkout ready after 'los laten'")
	}
	// Simulate a landing, which clears KeepSeparatePaths (commitCheckoutEditsAt)
	// — the acceptance itself must survive that.
	getOrCreateCheckoutAssignment("", "", 970804).KeepSeparatePaths = nil

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970804, "", "feature/x")
	if !ok || dir != checkout || decision != nil {
		t.Fatalf("expected 'los laten' to stay resolved after a landing, dir=%q decision=%+v ok=%v", dir, decision, ok)
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
	if !checkoutChoiceOpen("", "", 970801) {
		t.Fatal("the raised choice must be reported as open")
	}
	raised := getCheckoutAssignment("", "", 970801).Pending

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
	if getCheckoutAssignment("", "", 970801).Pending != raised {
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
	if checkoutChoiceOpen("", "", 970801) {
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

// Reported bug: two different open PRs both showed the same local-checkout
// folder pill on /pr-overview, because the ladder never excluded a directory
// another PR had already claimed — only a directory the reviewer explicitly
// rejected (a.Excluded). Here PR 1006 already owns c1; PR 1007's own ladder
// run, offered the exact same 2 registered candidates, must skip c1 and
// auto-pick c2 instead of either reusing c1 or asking an ambiguous
// "choose between c1/c2" question that could still land on c1.
func TestPrepareChatShellWorkDirNeverReusesAnotherPRsAssignedDir(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	c1 := cloneCheckoutDir(t, bareDir, "feature/x")
	c2 := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, c1, c2)

	assignCheckoutForTest(t, "", 1006, c1)

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1007, "", "feature/x")
	if decision != nil {
		t.Fatalf("unexpected decision: %+v", decision)
	}
	if !ok {
		t.Fatal("expected an automatic pick, got !ok")
	}
	if dir != c2 {
		t.Fatalf("dir = %q, want the free candidate %q (never the in-use %q)", dir, c2, c1)
	}
}

// With every directory of this repo held back — one claimed by another PR,
// one the reviewer rejected earlier — the ladder must NOT dead-end on "add a
// path to chatCheckoutDirs" (reported bug: "er is wel ruimte in ~/dev pp
// projecten"). It offers all of them as an explicit choice instead, each
// labelled with the reason it first fell out, plus a way out.
func TestPrepareChatShellWorkDirOffersEveryHeldBackDirAsALastResort(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	claimed := cloneCheckoutDir(t, bareDir, "feature/x")
	rejected := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, claimed, rejected)

	assignCheckoutForTest(t, "", 1030, claimed)
	getOrCreateCheckoutAssignment(dataDir, "", 1031).Excluded[rejected] = true

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1031, "", "feature/x")
	if ok || dir != "" {
		t.Fatalf("expected a choice, not a silent pick: dir=%q ok=%v", dir, ok)
	}
	if decision == nil || decision.Stage != checkoutStageChooseDirectory {
		t.Fatalf("decision = %+v, want a chooseDirectory choice", decision)
	}
	want := []string{
		claimed + checkoutOptionNoteSep + "in gebruik door PR 1030",
		rejected + checkoutOptionNoteSep + "eerder door jou afgewezen",
		optNoneOfThese,
	}
	for _, w := range want {
		if !slices.Contains(decision.Options, w) {
			t.Fatalf("options = %v, missing %q", decision.Options, w)
		}
	}
	if len(decision.Options) != len(want) {
		t.Fatalf("options = %v, want exactly %v", decision.Options, want)
	}
}

// Answering that last-resort choice with a directory another PR claims takes
// it over completely: this PR gets it, and the other PR's own assignment is
// released so the two can never both show the same folder pill.
func TestPrepareChatShellWorkDirTakesOverAClaimedDirOnAnswer(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	claimed := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, claimed)

	assignCheckoutForTest(t, "", 1032, claimed)

	_, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1033, "", "feature/x")
	if ok || decision == nil || len(decision.Options) != 2 {
		t.Fatalf("expected the claimed dir plus a way out: ok=%v decision=%+v", ok, decision)
	}
	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1033, decision.Options[0], "feature/x")
	if !ok || dir != claimed {
		t.Fatalf("dir = %q ok = %v decision = %+v, want the claimed dir taken over", dir, ok, decision)
	}
	if other := getOrCreateCheckoutAssignment(dataDir, "", 1032); other.Dir != "" {
		t.Fatalf("PR 1032 still claims %q, want its claim released", other.Dir)
	}
}

// "Geen van deze" must END the choice — not ask the identical question again
// one loop iteration later — and leave the honest dead-end wording behind for
// the write turn to report.
func TestPrepareChatShellWorkDirNoneOfTheseEndsTheChoice(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	rejected := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, rejected)

	a := getOrCreateCheckoutAssignment(dataDir, "", 1034)
	a.Excluded[rejected] = true

	if _, decision, _ := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1034, "", "feature/x"); decision == nil {
		t.Fatal("expected the last-resort choice first")
	}
	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 1034, optNoneOfThese, "feature/x")
	if ok || dir != "" || decision != nil {
		t.Fatalf("dir = %q decision = %+v ok = %v, want a plain dead end", dir, decision, ok)
	}
	if a.Pending != nil {
		t.Fatalf("expected the choice to be gone, got %+v", a.Pending)
	}
	if !strings.Contains(a.LastReason, rejected) {
		t.Fatalf("LastReason = %q, want it to name %q instead of blaming settings.json", a.LastReason, rejected)
	}
}

// The note on an option is only a LABEL — the answer still resolves to the
// bare directory.
func TestCheckoutOptionDirStripsItsNote(t *testing.T) {
	hold := checkoutHoldback{Claimed: map[string]int{"/dev/pap-4": 13606}}
	opt := annotateCheckoutOption("/dev/pap-4", hold)
	if opt != "/dev/pap-4"+checkoutOptionNoteSep+"in gebruik door PR 13606" {
		t.Fatalf("option = %q", opt)
	}
	if got := checkoutOptionDir(opt); got != "/dev/pap-4" {
		t.Fatalf("checkoutOptionDir(%q) = %q, want the bare path", opt, got)
	}
	if got := checkoutOptionDir("/dev/pap-4"); got != "/dev/pap-4" {
		t.Fatalf("an unannotated option must round-trip unchanged, got %q", got)
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
	dec := listAllCheckoutChoices([]checkoutCandidate{onTarget, mergedBase}, checkoutDiscovery{}, checkoutHoldback{})
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

	if exists, dirty, ahead, _ := checkoutLocalPendingState(ctx, "", "", 1007); !exists || dirty || ahead != 0 {
		t.Fatalf("clean checkout reported exists=%v dirty=%v ahead=%d, want true/false/0", exists, dirty, ahead)
	}

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("claude was here\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, dirty, _, _ := checkoutLocalPendingState(ctx, "", "", 1007); !dirty {
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
	if _, dirty, ahead, _ := checkoutLocalPendingState(ctx, "", "", 1007); dirty || ahead != 1 {
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
	if dec := listAllCheckoutChoices(nil, checkoutDiscovery{}, checkoutHoldback{}); dec == nil || len(dec.Options) != 0 || dec.Body == "" {
		t.Fatalf("zero candidates: got %+v, want a decision with an explanatory body and no options", dec)
	}
	one := []checkoutCandidate{{Dir: "/a"}}
	dec := listAllCheckoutChoices(one, checkoutDiscovery{}, checkoutHoldback{})
	if dec == nil || dec.Stage != checkoutStageChooseDirectory || len(dec.Options) != 1 || dec.Options[0] != "/a" {
		t.Fatalf("one candidate: got %+v, want it still offered as a choice, not auto-picked", dec)
	}
	many := []checkoutCandidate{{Dir: "/a"}, {Dir: "/b"}}
	dec = listAllCheckoutChoices(many, checkoutDiscovery{}, checkoutHoldback{})
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

	a := getOrCreateCheckoutAssignment("", "", 1011)
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
	a := getOrCreateCheckoutAssignment("", "", 1012)
	if a.Pending != nil {
		t.Fatalf("expected nothing persisted as pending, got %+v", a.Pending)
	}
}

func TestCheckoutSetOffClearsAssignmentButKeepsStashBookkeeping(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	a := getOrCreateCheckoutAssignment("", "", 1013)
	a.Dir = dir
	a.Branch = "feature/x"
	a.Excluded["/somewhere"] = true
	a.StashRef = "slash-chat-x"
	a.StashDir = dir

	checkoutSetOff("", "", 1013)

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
	a := getOrCreateCheckoutAssignment("", "", 1014)
	a.StashRef = "slash-chat-test-1014"
	a.StashDir = dir

	if err := checkoutRestoreStashNow(ctx, "", "", 1014); err != nil {
		t.Fatalf("restore stash now: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "foo.txt")); string(got) != "reviewer's own WIP\n" {
		t.Fatalf("expected the stashed change restored, got %q", got)
	}
	if a.StashRef != "" || a.StashDir != "" {
		t.Fatalf("expected stash bookkeeping cleared after restoring, got StashRef=%q StashDir=%q", a.StashRef, a.StashDir)
	}

	// A no-op, not an error, when nothing is pending.
	if err := checkoutRestoreStashNow(ctx, "", "", 1014); err != nil {
		t.Fatalf("restore with nothing pending should be a no-op, got: %v", err)
	}
}

func TestBuildCheckoutViewShapes(t *testing.T) {
	empty := buildCheckoutView("", "", 1015)
	if empty.Dir != "" || empty.Decision != nil || empty.StashPending {
		t.Fatalf("expected an empty view for a PR with no checkout activity, got %+v", empty)
	}
	if empty.RunID == "" {
		t.Fatal("expected RunID to always be present (a deterministic string), even with nothing assigned")
	}

	a := getOrCreateCheckoutAssignment("", "", 1016)
	a.Dir = "/home/reindert/dev/plug-and-pay-2"
	a.Branch = "feature/x"
	a.StashRef = "slash-chat-y"
	view := buildCheckoutView("", "", 1016)
	if view.Dir != a.Dir || view.DirName != "plug-and-pay-2" || view.Branch != "feature/x" || !view.StashPending {
		t.Fatalf("unexpected view: %+v", view)
	}
}

// checkoutView.PendingFiles mirrors chat_edit_pending.go's own registry —
// the review tree's "wordt aangepast" pill reads it straight off the same
// read model the checkout chip already polls.
func TestBuildCheckoutViewReportsPendingFiles(t *testing.T) {
	defer clearChatPendingFiles("", 1017)

	empty := buildCheckoutView("", "", 1017)
	if len(empty.PendingFiles) != 0 {
		t.Fatalf("expected no pending files yet, got %v", empty.PendingFiles)
	}

	markChatFilesPending("", 1017, []string{"src/Foo.php", "src/Bar.php"})
	view := buildCheckoutView("", "", 1017)
	if len(view.PendingFiles) != 2 || view.PendingFiles[0] != "src/Bar.php" || view.PendingFiles[1] != "src/Foo.php" {
		t.Fatalf("PendingFiles = %v, want the marked files sorted", view.PendingFiles)
	}

	clearChatPendingFiles("", 1017)
	view = buildCheckoutView("", "", 1017)
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

	empty := buildCheckoutView("", "", 1018)
	if len(empty.RefreshingFiles) != 0 {
		t.Fatalf("expected no refreshing files yet, got %v", empty.RefreshingFiles)
	}

	markChatRefreshPendingFiles("", 1018, []string{"src/Foo.php", "src/Bar.php"})
	view := buildCheckoutView("", "", 1018)
	if len(view.RefreshingFiles) != 2 || view.RefreshingFiles[0] != "src/Bar.php" || view.RefreshingFiles[1] != "src/Foo.php" {
		t.Fatalf("RefreshingFiles = %v, want the marked files sorted", view.RefreshingFiles)
	}

	clearChatRefreshPendingFiles("", 1018)
	view = buildCheckoutView("", "", 1018)
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
	getOrCreateCheckoutAssignment("", "", pr).Branch = headRefName

	if chatCheckoutNeedsLanding(ctx, "", "", pr) {
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

	if !chatCheckoutNeedsLanding(ctx, "", "", pr) {
		t.Fatal("a real, never-landed local commit should need landing")
	}

	// Simulate the actual landing plumbing (advancePendingRefFromCheckout,
	// chat_checkout.go) without going through a whole Claude turn.
	if err := advancePendingRefFromCheckout(ctx, checkout, "", pr, headRefName, false); err != nil {
		t.Fatalf("advancePendingRefFromCheckout: %v", err)
	}

	if chatCheckoutNeedsLanding(ctx, "", "", pr) {
		t.Fatal("a commit already mirrored onto the PR's pending ref must not be reported as needing landing again — this is the reported bug")
	}
}

// TestTurnChangedCheckoutGatesAutoLanding is the regression for a reviewer
// report: a pure question turn ("bestond dit niet eerder in een data class?"),
// which never even asks for write access, still produced the "Wijziging staat
// op ..." bubble — because the automatic landing was decided by the PR-WIDE
// chatCheckoutNeedsLanding alone, and the shared checkout already held
// outstanding work of its own (the reviewer's own uncommitted edits, or a
// local commit from earlier). The gate is now turn-scoped: no baseline (a
// read-only turn) means no landing, and a baseline that still matches means
// this turn changed nothing.
func TestTurnChangedCheckoutGatesAutoLanding(t *testing.T) {
	const headRefName = "feature/turnscoped"
	const conv = "conv-turnscoped"
	bareDir, _ := setupChatShadowRepo(t, headRefName, "v1\n")
	ctx := context.Background()
	const pr = 970742

	checkout := cloneCheckoutDir(t, bareDir, headRefName)
	assignCheckoutForTest(t, "", pr, checkout)
	getOrCreateCheckoutAssignment("", "", pr).Branch = headRefName

	// A read-only turn records no baseline at all.
	if turnChangedCheckout(ctx, "", "", pr, conv) {
		t.Fatal("a turn that never got write access must never trigger a landing")
	}

	// A write turn that ends up changing nothing must not either.
	recordTurnCheckoutBaseline(ctx, conv, checkout)
	if turnChangedCheckout(ctx, "", "", pr, conv) {
		t.Fatal("a write turn that changed nothing must not trigger a landing")
	}

	// A write turn that really edits the checkout does.
	recordTurnCheckoutBaseline(ctx, conv, checkout)
	if err := os.WriteFile(filepath.Join(checkout, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !turnChangedCheckout(ctx, "", "", pr, conv) {
		t.Fatal("a write turn that edited the checkout must trigger a landing")
	}

	// ... and so does one that only commits (HEAD moves, tree clean again).
	recordTurnCheckoutBaseline(ctx, conv, checkout)
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", checkout}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("add", "-A")
	run("commit", "-m", chatEditCommitSubject)
	if !turnChangedCheckout(ctx, "", "", pr, conv) {
		t.Fatal("a write turn that committed must trigger a landing")
	}

	// The baseline is consumed: a later turn can never re-read this one's.
	if turnChangedCheckout(ctx, "", "", pr, conv) {
		t.Fatal("the baseline must be consumed, so a later turn starts from nothing")
	}
}

// breakOrigin points dir's "origin" at a path that does not exist, so every
// `git fetch origin …` from that checkout fails the way an ssh-agent without
// a loaded key, an expired token or plain offline work fails on a real
// machine. The remote-tracking refs the clone already has stay untouched —
// exactly the state classifyCheckoutCandidate has to keep working from.
func breakOrigin(t *testing.T, dir string) {
	t.Helper()
	gone := filepath.Join(t.TempDir(), "no-such-remote.git")
	cmd := exec.Command("git", "-C", dir, "remote", "set-url", "origin", gone)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git remote set-url: %v: %s", err, out)
	}
}

// An unreachable origin must NOT cost the reviewer their work directory.
// Reported bug: `git fetch` failed for every candidate (the ssh-agent had no
// identities loaded), classifyCheckoutCandidate turned that into an error,
// every candidate was dropped, and the write turn answered "add a path to
// chatCheckoutDirs in settings.json" — while the correct checkout sat right
// there, already on the PR's own branch. Committing on top never needs
// origin; only the fast-forward does, and that is what SyncUnknown suppresses.
func TestPrepareChatShellWorkDirSurvivesUnreachableOrigin(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	writeCheckoutSettings(t, dataDir, checkout)
	breakOrigin(t, checkout)

	dir, decision, ok := prepareChatShellWorkDirAt(ctx, nil, dataDir, "", 970901, "", "feature/x")
	if decision != nil {
		t.Fatalf("unexpected decision with an unreachable origin: %+v", decision)
	}
	if !ok || dir != checkout {
		t.Fatalf("dir = %q, ok = %v; want %q, true", dir, ok, checkout)
	}
	if r, transient := checkoutFailureReason("", "", 970901); r != "" || transient {
		t.Fatalf("resolved fine but kept a failure reason: %q (transient=%v)", r, transient)
	}
}

// Same, one step harsher: the checkout has never seen this branch from origin
// at all, so there is not even a stale remote-tracking ref to compare with.
// Still usable — a write turn only ever commits on top — and still never
// fast-forwarded.
func TestClassifyCandidateWithoutAnyOriginRef(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	ctx := context.Background()
	checkout := cloneCheckoutDir(t, bareDir, "feature/x")
	if out, err := exec.Command("git", "-C", checkout, "update-ref", "-d", "refs/remotes/origin/feature/x").CombinedOutput(); err != nil {
		t.Fatalf("drop remote-tracking ref: %v: %s", err, out)
	}
	breakOrigin(t, checkout)

	c, err := classifyCheckoutCandidate(ctx, checkout, "feature/x", "master")
	if err != nil {
		t.Fatalf("classify: %v", err)
	}
	if !c.OnTargetBranch || !c.SyncUnknown || c.BehindOrigin {
		t.Fatalf("candidate = %+v; want OnTargetBranch and SyncUnknown, never BehindOrigin", c)
	}
}

// A dead end must say what was actually in the way. Every checkout of this
// repo being on someone else's unmerged branch is a different problem from
// "no checkout configured", and the reviewer-facing text has to tell them
// apart — see checkoutDiscovery.reason.
func TestCheckoutDiscoveryReasonNamesTheRealObstacle(t *testing.T) {
	if r := (checkoutDiscovery{}).reason(); r != "" {
		t.Fatalf("nothing found should stay silent (the settings.json wording is right there), got %q", r)
	}
	busy := checkoutDiscovery{Matched: 1, Busy: []string{"/dev/pap-2"}}.reason()
	if !strings.Contains(busy, "/dev/pap-2") || !strings.Contains(busy, "gemerged") {
		t.Fatalf("busy reason = %q", busy)
	}
	broken := checkoutDiscovery{Matched: 1, Broken: []string{"/dev/pap-3"}}.reason()
	if !strings.Contains(broken, "/dev/pap-3") || !strings.Contains(broken, "git fetch") {
		t.Fatalf("broken reason = %q", broken)
	}
	held := checkoutDiscovery{Matched: 1, HeldBack: []string{"/dev/pap-4 — in gebruik door PR 13606"}}.reason()
	if !strings.Contains(held, "/dev/pap-4") || !strings.Contains(held, "PR 13606") {
		t.Fatalf("held-back reason = %q, want it to name the directory and its holder", held)
	}
}

// The landing must survive the same unreachable origin the selection ladder
// now survives (TestPrepareChatShellWorkDirSurvivesUnreachableOrigin).
// Reported bug: Claude made the edit, said so, and the very next bubble was a
// red "Kon de laatste stand van de branch niet ophalen." — the fetch before
// the commit was fatal, so a finished edit was left uncommitted with no way
// forward. It lands on a new commit instead, never an amend (that is the one
// decision a stale origin cannot answer safely).
func TestCommitCheckoutEditsLandsWithUnreachableOrigin(t *testing.T) {
	bareDir, cloneDir := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, "", 970902, dir)
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	breakOrigin(t, dir)

	msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 970902, "conv-offline", "turn-offline", "feature/x")
	if msg.Kind == chat.KindError {
		t.Fatalf("landing reported an error with an unreachable origin: %+v", msg)
	}
	sha := pendingRefSHA(ctx, "", prPendingRef("", 970902, "feature/x"))
	if sha == "" {
		t.Fatal("no pending ref after landing with an unreachable origin")
	}
	out, err := exec.Command("git", "-C", cloneDir, "show", sha+":foo.txt").Output()
	if err != nil || string(out) != "edited by claude\n" {
		t.Fatalf("pending ref content = %q, err %v; want the edit", out, err)
	}

	// A SECOND edit in the same state must stack a new commit rather than
	// amend the first one: "is that commit already pushed?" is exactly what a
	// stale origin cannot answer.
	before, _ := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited again\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := commitCheckoutEditsAt(ctx, cm, dataDir, "", 970902, "conv-offline", "turn-offline-2", "feature/x"); msg.Kind == chat.KindError {
		t.Fatalf("second landing reported an error: %+v", msg)
	}
	parent, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD^").Output()
	if err != nil {
		t.Fatalf("git rev-parse HEAD^: %v", err)
	}
	if strings.TrimSpace(string(parent)) != strings.TrimSpace(string(before)) {
		t.Fatalf("second commit's parent = %q, want the first commit %q (a stale origin must never amend)", parent, before)
	}
}

// TestGitLockContentionRegexMatchesRealIndexLockError pins
// gitLockContentionRE against git's ACTUAL error text for the one thing it is
// meant to recognise: another process (or a stray leftover file) already
// holding this checkout's index.lock. A synthetic string match would only
// prove the regex matches whatever we made up, not what git really says.
func TestGitLockContentionRegexMatchesRealIndexLockError(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	ctx := context.Background()

	lock := filepath.Join(dir, ".git", "index.lock")
	if err := os.WriteFile(lock, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(lock)

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := runGitIn(ctx, dir, "add", "-A")
	if err == nil {
		t.Fatal("expected `git add -A` to fail while index.lock exists")
	}
	if !gitLockContentionRE.MatchString(err.Error()) {
		t.Fatalf("gitLockContentionRE did not match git's real error: %q", err.Error())
	}
}

// TestRunGitInRetryOnLockSucceedsOnceTheLockReleases is the actual mitigation
// this regex feeds: a lock held by something else for a moment must not fail
// the whole landing — one bounded retry after a short wait is enough once
// the other process (in this test, a goroutine standing in for "an IDE or a
// terminal the reviewer also has open") releases it.
func TestRunGitInRetryOnLockSucceedsOnceTheLockReleases(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	ctx := context.Background()

	lock := filepath.Join(dir, ".git", "index.lock")
	if err := os.WriteFile(lock, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(100 * time.Millisecond) // well inside runGitInRetryOnLock's 300ms wait
		os.Remove(lock)
		close(released)
	}()

	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runGitInRetryOnLock(ctx, dir, "add", "-A"); err != nil {
		t.Fatalf("expected the retry to succeed once the lock released, got: %v", err)
	}
	<-released
}

// TestProcessChatMergeOpensLandingFailedOverlayOnACleanTreeFailure is the
// regression for the blocking-error overlay: a landing failure that leaves
// the checkout's working tree CLEAN (here, the exact same unresolved-conflict
// shape TestProcessChatMergeAbortsAndDegradesOnUnresolvedConflict already
// covers — the merge is aborted, no unmerged paths remain) has no natural
// checkoutStageDirtyTree question to fall back on, so it must raise its own
// checkoutStageLandingFailed decision — which the existing werkmap overlay
// (src/workDirOverlay.mjs) already renders unchanged, see
// checkoutStageLandingFailed's own doc comment.
func TestProcessChatMergeOpensLandingFailedOverlayOnACleanTreeFailure(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "foo v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, "", 2012, dir)
	// This conversation edits the SAME line another one already pushed — a
	// genuine, unavoidable conflict (mirrors
	// TestProcessChatMergeAbortsAndDegradesOnUnresolvedConflict exactly).
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("foo edited by this conversation\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pushToBare(t, bareDir, "feature/x", "foo edited by someone else\n")

	msg := processChatMergeAt(ctx, nil, cm, &claude.Fake{}, dataDir, chatMergeInput{
		PR: 2012, ConversationID: "conv-cleanfail", TurnID: "turn-cleanfail",
	}, "feature/x")
	if msg.Kind != chat.KindError {
		t.Fatalf("expected the landing to fail, got: %+v", msg)
	}

	paths, err := snapshotDirtyPaths(ctx, dir)
	if err != nil {
		t.Fatalf("snapshotDirtyPaths: %v", err)
	}
	if len(paths) != 0 {
		t.Fatalf("expected a clean working tree after the aborted merge, got dirty paths: %v", paths)
	}

	a := getCheckoutAssignment(dataDir, "", 2012)
	if a == nil || a.Pending == nil {
		t.Fatal("expected a checkoutStageLandingFailed decision to be raised")
	}
	if a.Pending.Stage != checkoutStageLandingFailed {
		t.Fatalf("Pending.Stage = %q, want %q", a.Pending.Stage, checkoutStageLandingFailed)
	}
	if a.Pending.Body != msg.Body {
		t.Fatalf("decision Body = %q, want the same reason as the chat message %q", a.Pending.Body, msg.Body)
	}
}
