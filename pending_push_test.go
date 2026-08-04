package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/chat"
)

// pending_push_test.go covers the deferred push: the read model that feeds the
// todo row, the push Activity itself (both outcomes), and the queue dispatch
// that gets there. Same offline harness as chat_shadow_test.go — a throwaway
// bare "origin" plus a local clone SLASH_REPO_DIR points at — so nothing here
// touches the real developer clone or the network.

// landOneEdit lands one file change on pr's pending ref through the real
// commit/land path, and returns the shadow dir it used.
func landOneEdit(t *testing.T, dataDir string, pr int, conversationID, headRefName, file, content string) {
	t.Helper()
	ctx := context.Background()
	dir, err := ensureChatShadowWorktreeAt(ctx, dataDir, pr, conversationID, headRefName)
	if err != nil {
		t.Fatalf("ensure shadow: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := commitChatShadowEditsAt(ctx, testChatModule(t), dataDir, pr, conversationID, "turn-"+conversationID, headRefName); msg.Kind == chat.KindError {
		t.Fatalf("landing failed: %+v", msg)
	}
}

// The read model reports what the todo row needs, straight from git: the branch
// to push to, how many commits are waiting, and which files they touch (the
// latter is what marks the affected blocks as unpushed in the UI).
func TestLoadPendingPushReportsLandedWork(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	if v := loadPendingPush(ctx, 3001); v != nil {
		t.Fatalf("expected no pending push before anything landed, got %+v", v)
	}

	landOneEdit(t, dataDir, 3001, "conv-a", "feature/x", "foo.txt", "edited by claude\n")

	v := loadPendingPush(ctx, 3001)
	if v == nil {
		t.Fatal("expected a pending push after a landing")
	}
	if v.HeadRef != "feature/x" {
		t.Fatalf("headRef = %q, want feature/x", v.HeadRef)
	}
	if v.Ahead != 1 {
		t.Fatalf("ahead = %d, want 1", v.Ahead)
	}
	if v.State != pendingPushReady {
		t.Fatalf("state = %q, want %q", v.State, pendingPushReady)
	}
	if !reflect.DeepEqual(v.Files, []string{"foo.txt"}) {
		t.Fatalf("files = %v, want [foo.txt]", v.Files)
	}
	if v.PushRunID != chatMergeQueueRunID(3001) {
		t.Fatalf("pushRunId = %q, want %q", v.PushRunID, chatMergeQueueRunID(3001))
	}
}

// A successful push puts the landed commit on the real branch and drops the
// pending ref, which is what makes the todo row disappear.
func TestPushPendingPRPushesAndDropsTheRef(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	landOneEdit(t, dataDir, 3002, "conv-b", "feature/x", "foo.txt", "edited by claude\n")

	pushPendingPR(ctx, nil, 3002)

	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	if got, _ := os.ReadFile(filepath.Join(verify, "foo.txt")); string(got) != "edited by claude\n" {
		t.Fatalf("pushed content = %q, want the edit", got)
	}
	if v := loadPendingPush(ctx, 3002); v != nil {
		t.Fatalf("pending ref survived a successful push: %+v", v)
	}
}

// A push the remote refuses (someone else pushed meanwhile) must never force
// anything: the ref is KEPT so the reviewer can merge and retry, and the row
// reports a failure with an actionable reason.
func TestPushPendingPRKeepsRefWhenRefused(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	landOneEdit(t, dataDir, 3003, "conv-c", "feature/x", "foo.txt", "edited by claude\n")
	// Only now does someone else push, so our pending ref is no longer a
	// fast-forward of the branch.
	pushToBare(t, bareDir, "feature/x", "someone else\n")

	pushPendingPR(ctx, nil, 3003)

	v := loadPendingPush(ctx, 3003)
	if v == nil {
		t.Fatal("pending ref was dropped even though the push was refused")
	}
	if v.State != pendingPushFailed {
		t.Fatalf("state = %q, want %q", v.State, pendingPushFailed)
	}
	if v.Error == "" {
		t.Fatal("expected a reason the reviewer can act on")
	}

	// And the remote must be exactly what the other party pushed — untouched.
	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	if got, _ := os.ReadFile(filepath.Join(verify, "foo.txt")); string(got) != "someone else\n" {
		t.Fatalf("remote content = %q, want it untouched by the refused push", got)
	}
}

// The queue dispatches on the Signal's own Action: a "push" request runs
// pushPendingPR and never the landing path, and both kinds keep sharing one
// Execution (so a push can never overlap a landing for the same PR).
func TestChatMergeQueueDispatchesPushAction(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	engine.RegisterWorkflow(WorkflowChatMerge, chatMergeQueueWorkflow)

	var mu sync.Mutex
	var calls []string
	engine.RegisterActivity("processChatMerge", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatMergeInput
		_ = json.Unmarshal(in, &arg)
		mu.Lock()
		calls = append(calls, "land:"+arg.ConversationID)
		mu.Unlock()
		return nil, nil
	})
	engine.RegisterActivity("pushPendingPR", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatMergeInput
		_ = json.Unmarshal(in, &arg)
		mu.Lock()
		calls = append(calls, "push")
		mu.Unlock()
		if arg.PR != 9003 {
			t.Errorf("push Activity got pr %d, want 9003", arg.PR)
		}
		return nil, nil
	})

	runID, err := engine.StartWorkflowID(chatMergeQueueRunID(9003), WorkflowChatMerge, ChatMergeQueueInput{PR: 9003})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalChatMerge, ChatMergeRequest{ConversationID: "conv-1"}); err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalChatMerge, ChatMergeRequest{Action: chatMergeActionPush}); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	got := append([]string(nil), calls...)
	mu.Unlock()
	if want := []string{"land:conv-1", "push"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("activities = %v, want %v", got, want)
	}
}
