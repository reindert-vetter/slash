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

	var checkoutDir string
	sink := chatProgressSink("", 5, "conv", &checkoutDir)
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
	var checkoutDir string
	chatProgressSink("", 9, "conv-f", &checkoutDir)(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "bijna"})
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

// An Edit/Write tool event accumulates a repo-relative path into
// EditedFiles (never overwritten by the next tool call, unlike Tool/Detail),
// a repeat of the same path is not duplicated, and a Read/Grep/Glob event
// never counts at all — the review tree's own per-block "wordt aangepast"
// pill is driven off exactly this list (see chat_edit_pending.go).
func TestChatProgressAccumulatesEditedFiles(t *testing.T) {
	resetChatProgress()
	defer resetChatProgress()
	defer clearChatPendingFiles("", 21)

	startChatProgress("", 21, "conv-edit")
	var checkoutDir string
	sink := chatProgressSink("", 21, "conv-edit", &checkoutDir)

	// Before the shell attempt resolves its own WorkDir, checkoutDir is still
	// empty — a Read here (the cheap read-only attempt) must never be
	// recorded as an edit.
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Read", Detail: "/checkout/src/Foo.php"})
	p, _ := chatProgressFor("conv-edit")
	if len(p.EditedFiles) != 0 {
		t.Fatalf("a Read must never be recorded as an edit, got %v", p.EditedFiles)
	}

	// The shell attempt starts: the caller (runOneClaudeTurn) sets the
	// checkout dir right before invoking it.
	checkoutDir = "/checkout"
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Edit", Detail: "/checkout/src/Foo.php"})
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Edit", Detail: "/checkout/src/Foo.php"}) // same file again
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Write", Detail: "/checkout/src/Bar.php"})
	p, _ = chatProgressFor("conv-edit")
	if len(p.EditedFiles) != 2 || p.EditedFiles[0] != "src/Foo.php" || p.EditedFiles[1] != "src/Bar.php" {
		t.Fatalf("EditedFiles = %v, want [src/Foo.php src/Bar.php] (relative, de-duplicated)", p.EditedFiles)
	}

	finishChatProgress("", 21, "conv-edit")
	pending := chatPendingEditedFilesFor("", 21)
	if len(pending) != 2 || pending[0] != "src/Bar.php" || pending[1] != "src/Foo.php" {
		t.Fatalf("pending files after finish = %v, want the turn's own edited files (sorted)", pending)
	}
}

// resetChatProgressPartial clears attempt 1's leftover answer (typically the
// strict {"type":"need_write"} directive itself, streamed like any other
// text) before attempt 2 starts writing its own real answer — without this,
// the two stayed glued together in the live bubble for the rest of the turn.
func TestChatProgressResetPartialBeforeShellAttempt(t *testing.T) {
	resetChatProgress()
	defer resetChatProgress()

	startChatProgress("", 33, "conv-reset")
	var checkoutDir string
	sink := chatProgressSink("", 33, "conv-reset", &checkoutDir)

	// Attempt 1: the whole streamed answer is the escalation directive.
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: `{"type":"need_write"}`})
	p, _ := chatProgressFor("conv-reset")
	if p.Partial != `{"type":"need_write"}` {
		t.Fatalf("attempt 1 partial = %q", p.Partial)
	}

	// runOneClaudeTurn resets right before invoking attempt 2.
	resetChatProgressPartial("", 33, "conv-reset")
	p, ok := chatProgressFor("conv-reset")
	if !ok || p.Partial != "" || p.Tool != "" || p.Detail != "" {
		t.Fatalf("after reset: %+v ok=%v", p, ok)
	}

	// Attempt 2's own real answer must not carry attempt 1's leftover text.
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "Nu de flag toevoegen."})
	p, _ = chatProgressFor("conv-reset")
	if p.Partial != "Nu de flag toevoegen." {
		t.Fatalf("attempt 2 partial = %q, want no leftover directive text", p.Partial)
	}
}

// A brand-new text content block starting right after a tool/thinking block
// gets a blank-line separator from whatever text preceded it — Claude's own
// deltas never carry a leading space/newline across that gap, so naively
// appending glued two distinct sentences together with nothing in between
// (reported: "toevoegen.Nu de Unleash-config...").
func TestChatProgressSeparatesTextBlocksAfterATool(t *testing.T) {
	resetChatProgress()
	defer resetChatProgress()

	startChatProgress("", 34, "conv-sep")
	var checkoutDir string
	sink := chatProgressSink("", 34, "conv-sep", &checkoutDir)

	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "Nu de flag toevoegen."})
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Edit", Detail: "src/Foo.php"})
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "Nu de Unleash-config en de tests."})

	p, _ := chatProgressFor("conv-sep")
	want := "Nu de flag toevoegen.\n\nNu de Unleash-config en de tests."
	if p.Partial != want {
		t.Fatalf("partial = %q, want %q", p.Partial, want)
	}

	// Two consecutive text deltas of the SAME block (no tool in between) must
	// stay glued exactly as before — only a real block boundary separates.
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: " Klaar."})
	p, _ = chatProgressFor("conv-sep")
	if p.Partial != want+" Klaar." {
		t.Fatalf("partial after same-block delta = %q", p.Partial)
	}
}
