package main

import (
	"strings"
	"testing"

	"slash/modules/claude"
)

// resetChatProgress keeps the package-level store from leaking between tests
// (it is process-wide by design, like ingestProgressByPR).
func resetChatProgress() {
	chatProgressMu.Lock()
	chatProgressByConv = map[string]chatProgress{}
	chatProgressMu.Unlock()
}

// A turn's whole volatile lifecycle: start → events → finish, with the store
// empty again afterwards so a later reader sees "no running turn".
func TestChatProgressLifecycle(t *testing.T) {
	resetChatProgress()
	defer resetChatProgress()

	if _, ok := chatProgressFor("conv"); ok {
		t.Fatal("expected no progress before the turn starts")
	}
	startChatProgress("", 5, "conv")
	p, ok := chatProgressFor("conv")
	if !ok || !p.Running || p.Phase != chatPhasePreparing {
		t.Fatalf("after start: %+v ok=%v", p, ok)
	}

	// Local prep finished, the claude CLI is about to be invoked: the
	// dedicated advanceChatProgress transition, mirroring what runOneClaudeTurn
	// does between prepareChatShellWorkDir and cl.RunChat.
	advanceChatProgress("", 5, "conv", chatPhaseStarting)
	p, _ = chatProgressFor("conv")
	if p.Phase != chatPhaseStarting {
		t.Fatalf("after advanceChatProgress: %+v", p)
	}

	sink := chatProgressSink("", 5, "conv")
	sink(claude.ChatEvent{Kind: claude.ChatEventThinking})
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Read"})
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Read", Detail: "src/Foo.php"})
	p, _ = chatProgressFor("conv")
	if p.Phase != chatPhaseTool || p.Tool != "Read" || p.Detail != "src/Foo.php" {
		t.Fatalf("after tool events: %+v", p)
	}

	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "Hal"})
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "lo"})
	p, _ = chatProgressFor("conv")
	if p.Phase != chatPhaseWriting || p.Partial != "Hallo" {
		t.Fatalf("after text deltas: %+v", p)
	}
	// A tool announcement without arguments must not wipe the richer detail of
	// the same block, but real new text must clear the stale tool label.
	if p.Tool != "" || p.Detail != "" {
		t.Fatalf("writing phase should have cleared the tool label: %+v", p)
	}

	finishChatProgress("", 5, "conv")
	if _, ok := chatProgressFor("conv"); ok {
		t.Fatal("expected the finished turn to be forgotten")
	}
	// A late frame after the turn ended is a no-op, not a resurrection.
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "late"})
	if _, ok := chatProgressFor("conv"); ok {
		t.Fatal("a late event must not recreate a finished turn")
	}
}

// The reviewer must learn a turn ended even though the snapshot is dropped:
// finishChatProgress publishes one last Running:false frame (keeping the
// partial text) before forgetting it.
func TestChatProgressPublishesFinalFrame(t *testing.T) {
	resetChatProgress()
	defer resetChatProgress()

	id, sub := events.subscribe("") // "" = every PR of every repo
	defer events.unsubscribe(id)

	startChatProgress("", 9, "conv-f")
	chatProgressSink("", 9, "conv-f")(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "bijna"})
	finishChatProgress("", 9, "conv-f")

	var last busEvent
	for len(sub.ch) > 0 {
		last = <-sub.ch
	}
	if last.Type != eventChatProgress || last.Key != "conv-f" {
		t.Fatalf("last event = %+v", last)
	}
	if !strings.Contains(string(last.Data), `"running":false`) || !strings.Contains(string(last.Data), `"partial":"bijna"`) {
		t.Fatalf("final frame should report a finished turn with its partial text: %s", last.Data)
	}
}
