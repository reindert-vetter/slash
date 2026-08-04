package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/chat"
	"slash/modules/claude"
)

// chat_merge_test.go exercises processChatMergeAt (the "...At"-suffixed body
// once the PR's head branch name is already known — the same testability seam
// chat_shadow_test.go's own commitChatShadowEditsAt/ensureChatShadowWorktreeAt
// tests use) against a throwaway local bare repo as "origin", offline: no
// gh/network call, and claude.Fake never really edits a file (a mechanical
// property of the fake, not of this feature — see the "Known test boundary"
// note on the last test below).

// setupChatMergeRepo is setupChatShadowRepo (chat_shadow_test.go) plus a
// SECOND, independent file, so a test can simulate two chat conversations
// touching different files (a clean auto-merge, no conflict) as well as the
// same file (a genuine conflict).
func setupChatMergeRepo(t *testing.T, headRefName string) (bareDir, cloneDir string) {
	t.Helper()
	bareDir, cloneDir = setupChatShadowRepo(t, headRefName, "foo v1\n")
	// Added via its own throwaway checkout of headRefName (mirrors
	// pushFileToBare below) rather than the shared cloneDir directly — that
	// clone's own checked-out branch is whatever the bare repo's default HEAD
	// happens to be, not necessarily headRefName.
	pushFileToBare(t, bareDir, headRefName, "bar.txt", "bar v1\n")
	return bareDir, cloneDir
}

// pushFileToBare pushes a change to ONE named file directly onto the bare
// origin's headRefName, independent of any shadow worktree — the "someone
// else's chat conversation already landed a commit" scenario.
func pushFileToBare(t *testing.T, bareDir, headRefName, file, content string) {
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
	if err := os.WriteFile(filepath.Join(seed, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "advance "+file)
	run("push", "origin", headRefName)
}

func TestProcessChatMergeCleanlyAutoMergesNonOverlappingEdit(t *testing.T) {
	bareDir, _ := setupChatMergeRepo(t, "feature/x")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 2001, "conv-x", "feature/x")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	// This conversation's own edit touches foo.txt only.
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("foo edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Another chat conversation's commit lands on the PR branch first, touching
	// a DIFFERENT file — git can merge this on its own, no AI needed.
	pushFileToBare(t, bareDir, "feature/x", "bar.txt", "bar edited elsewhere\n")

	msg := processChatMergeAt(ctx, cm, &claude.Fake{}, dataDir, chatMergeInput{
		PR: 2001, ConversationID: "conv-x", TurnID: "turn-x",
	}, "feature/x")
	if msg.Kind == chat.KindError {
		t.Fatalf("expected a clean auto-merge success, got error: %+v", msg)
	}
	if !strings.Contains(msg.Body, "Automatisch samengevoegd") {
		t.Fatalf("expected the auto-merge wording, got: %q", msg.Body)
	}

	// Both edits must be present on the PR's pending ref afterwards (the
	// landing target — the push to GitHub is a separate, reviewer-triggered
	// step, see landAndReclaimChatShadow).
	if got := pendingFileAt(t, 2001, "feature/x", "foo.txt"); got != "foo edited by claude\n" {
		t.Fatalf("foo.txt = %q; want the chat conversation's own edit", got)
	}
	if got := pendingFileAt(t, 2001, "feature/x", "bar.txt"); got != "bar edited elsewhere\n" {
		t.Fatalf("bar.txt = %q; want the other conversation's edit", got)
	}

	// The shadow worktree/branch must have been reclaimed, exactly like an
	// ordinary fast-forward landing (commitChatShadowEditsAt's own reclaim step).
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("expected the shadow worktree to be reclaimed, stat err = %v", err)
	}
}

func TestProcessChatMergeSerializesTwoConversationsInArrivalOrder(t *testing.T) {
	// Two conversations both touch DIFFERENT files, and both are asked to
	// commit in the same order their requests would be queued in — a merge
	// queue's whole point is that the second one sees the first's already-
	// landed commit and cleanly merges around it, rather than racing it.
	setupChatMergeRepo(t, "feature/x")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dirA, err := ensureChatShadowWorktreeAt(ctx, dataDir, 2002, "conv-a", "feature/x")
	if err != nil {
		t.Fatalf("ensure a: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dirA, "foo.txt"), []byte("foo from a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dirB, err := ensureChatShadowWorktreeAt(ctx, dataDir, 2002, "conv-b", "feature/x")
	if err != nil {
		t.Fatalf("ensure b: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dirB, "bar.txt"), []byte("bar from b\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Request A processed first: plain fast-forward push.
	msgA := processChatMergeAt(ctx, cm, &claude.Fake{}, dataDir, chatMergeInput{
		PR: 2002, ConversationID: "conv-a", TurnID: "turn-a",
	}, "feature/x")
	if msgA.Kind == chat.KindError {
		t.Fatalf("conversation a: expected success, got %+v", msgA)
	}
	if strings.Contains(msgA.Body, "samengevoegd") {
		t.Fatalf("conversation a should be a plain fast-forward, got: %q", msgA.Body)
	}

	// Request B processed second, AFTER a's commit already landed — this is the
	// exact race the merge queue exists to serialize instead of both pushes
	// failing/racing each other.
	msgB := processChatMergeAt(ctx, cm, &claude.Fake{}, dataDir, chatMergeInput{
		PR: 2002, ConversationID: "conv-b", TurnID: "turn-b",
	}, "feature/x")
	if msgB.Kind == chat.KindError {
		t.Fatalf("conversation b: expected an auto-merge success, got %+v", msgB)
	}
	if !strings.Contains(msgB.Body, "Automatisch samengevoegd") {
		t.Fatalf("conversation b: expected the auto-merge wording, got: %q", msgB.Body)
	}

	foo := pendingFileAt(t, 2002, "feature/x", "foo.txt")
	bar := pendingFileAt(t, 2002, "feature/x", "bar.txt")
	if foo != "foo from a\n" || bar != "bar from b\n" {
		t.Fatalf("both edits should have landed: foo=%q bar=%q", foo, bar)
	}
}

// pendingFileAt reads one file as of the PR's pending ref (the landing target,
// see prPendingRef) — the "did this really land?" assertion every merge test
// needs now that landing no longer pushes to the remote.
func pendingFileAt(t *testing.T, pr int, headRefName, path string) string {
	t.Helper()
	sha := pendingRefSHA(context.Background(), prPendingRef(pr, headRefName))
	if sha == "" {
		t.Fatalf("pending ref for pr %d/%s does not exist", pr, headRefName)
	}
	out, err := exec.Command("git", "-C", os.Getenv("SLASH_REPO_DIR"), "show", sha+":"+path).Output()
	if err != nil {
		t.Fatalf("git show %s:%s: %v", sha, path, err)
	}
	return string(out)
}

// TestProcessChatMergeAbortsAndDegradesOnUnresolvedConflict covers the real
// git-conflict path up to (and including) the Claude attempt, using
// claude.Fake — which never actually touches files (it only returns
// programmed text, see modules/claude's Fake.Run doc comment). So this proves
// the conflict is genuinely DETECTED, that Claude is genuinely INVOKED, and
// that a resolution attempt which leaves conflict markers in place is
// correctly treated as a failure (merge aborted, shadow left clean, the
// dedicated conflict-failure message shown) — never a forced/partial push.
//
// KNOWN TEST BOUNDARY, same category as chatActionEdit's own (see
// .claude/docs/workflows-comments.md, "Agentic edits" — chat_shadow_test.go's
// header comment): a real Claude CLI call that actually edits the conflicted
// file and clears the markers is not exercisable offline, so the "Claude truly
// resolves it" success path is not covered here — only manually/interactively.
func TestProcessChatMergeAbortsAndDegradesOnUnresolvedConflict(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()
	cm := testChatModule(t)

	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, 2003, "conv-c", "feature/x")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	// This conversation edits the SAME line another one already pushed —
	// a genuine, unavoidable conflict.
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("foo edited by this conversation\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pushToBare(t, bareDir, "feature/x", "foo edited by someone else\n")

	fake := &claude.Fake{}
	msg := processChatMergeAt(ctx, cm, fake, dataDir, chatMergeInput{
		PR: 2003, ConversationID: "conv-c", TurnID: "turn-c",
	}, "feature/x")

	if msg.Kind != chat.KindError {
		t.Fatalf("expected an error message for an unresolved conflict, got: %+v", msg)
	}
	if !strings.Contains(msg.Body, "samenvoegconflict") {
		t.Fatalf("expected the conflict-specific wording, got: %q", msg.Body)
	}
	if fake.CallCount() != 1 {
		t.Fatalf("expected exactly one begrensde Claude attempt, got %d calls", fake.CallCount())
	}

	// The shadow's own working tree must be clean again (merge aborted) — no
	// leftover conflict markers, so a later "commit" click starts from a known,
	// clean state.
	remaining, err := chatShadowConflictedPaths(ctx, dir)
	if err != nil {
		t.Fatalf("chatShadowConflictedPaths: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("expected no unmerged paths after the abort, got %v", remaining)
	}

	// The real branch must be untouched by the failed attempt (no partial/
	// forced push).
	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	got, err := os.ReadFile(filepath.Join(verify, "foo.txt"))
	if err != nil || string(got) != "foo edited by someone else\n" {
		t.Fatalf("bare repo content = %q, err %v; want it untouched by the failed merge", got, err)
	}
}

// TestChatMergeQueueProcessesRequestsInArrivalOrder is the serialization
// guarantee itself, tested at the workflow-definition level (not the git
// plumbing, which the tests above already cover): one Execution per PR,
// looping on SignalChatMerge, must run exactly one Activity per Signal and
// must run them in the order the Signals were appended — the whole reason
// "commit" requests from different claude_chat conversations land one after
// another instead of racing. Uses a bare tembed engine with a STUB
// "processChatMerge" Activity (no git/gh/claude at all) so this test is only
// about the queue's own ordering/determinism, never about the plumbing.
func TestChatMergeQueueProcessesRequestsInArrivalOrder(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	engine.RegisterWorkflow(WorkflowChatMerge, chatMergeQueueWorkflow)

	var mu sync.Mutex
	var processed []string
	engine.RegisterActivity("processChatMerge", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatMergeInput
		_ = json.Unmarshal(in, &arg)
		mu.Lock()
		processed = append(processed, arg.ConversationID)
		mu.Unlock()
		return nil, nil
	})

	runID, err := engine.StartWorkflowID(chatMergeQueueRunID(9001), WorkflowChatMerge, ChatMergeQueueInput{PR: 9001})
	if err != nil {
		t.Fatal(err)
	}

	for _, conv := range []string{"conv-1", "conv-2", "conv-3"} {
		if err := engine.SignalWorkflow(runID, SignalChatMerge, ChatMergeRequest{ConversationID: conv}); err != nil {
			t.Fatal(err)
		}
	}

	mu.Lock()
	got := append([]string(nil), processed...)
	mu.Unlock()
	want := []string{"conv-1", "conv-2", "conv-3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("processed order = %v, want %v", got, want)
	}
}

// TestEnsureChatMergeQueueIsIdempotent mirrors StartClaudeChat's own
// idempotency test: ensuring the queue twice for the same PR must reuse the
// same Execution, never start a second one (which would defeat the whole
// point — two queues for one PR would serialize nothing together).
func TestEnsureChatMergeQueueIsIdempotent(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	engine.RegisterWorkflow(WorkflowChatMerge, chatMergeQueueWorkflow)
	engine.RegisterActivity("processChatMerge", func(ctx context.Context, in []byte) ([]byte, error) {
		return nil, nil
	})
	m := &TaskManager{engine: engine}

	runID, err := m.EnsureChatMergeQueue(9002)
	if err != nil {
		t.Fatal(err)
	}
	again, err := m.EnsureChatMergeQueue(9002)
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("EnsureChatMergeQueue returned a new run ID %q, want reuse of %q", again, runID)
	}
}
