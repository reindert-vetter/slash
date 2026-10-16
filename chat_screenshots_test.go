package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"slash/modules/claude"
)

func TestWantsChatScreenshots(t *testing.T) {
	yes := []string{
		"maak een screenshot van de admin",
		"Draai de Containers en kijk of het werkt",
		"start docker even",
		"kun je een schermafbeelding maken?",
		"open het in de browser",
		"Take a SCREENSHOT please",
		"gebruik playwright",
	}
	no := []string{"pas foo.txt aan", "push maar", "", "waarom faalt deze test?"}
	for _, s := range yes {
		if !wantsChatScreenshots(s) {
			t.Errorf("wantsChatScreenshots(%q) = false, want true", s)
		}
	}
	for _, s := range no {
		if wantsChatScreenshots(s) {
			t.Errorf("wantsChatScreenshots(%q) = true, want false", s)
		}
	}
}

// TestRunOneClaudeTurnShowsScreenshots proves a screenshot request's shell
// attempt gets Playwright MCP plus a per-turn dir, and that an image written
// there ends up as an attachment on the saved assistant message (and the dir
// is removed afterwards). A non-screenshot write turn gets no MCP at all.
func TestRunOneClaudeTurnShowsScreenshots(t *testing.T) {
	const headRefName = "feature/screenshot-turn"
	bareDir, _ := setupChatShadowRepo(t, headRefName, "hello\n")
	stubReachableGh(t, headRefName)

	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970731, "comment-shots"
	m.appDataDir = t.TempDir() // keep the attachment store out of the repo
	dataDir := t.TempDir()
	checkoutDir := cloneCheckoutDir(t, bareDir, headRefName)
	writeCheckoutSettings(t, dataDir, checkoutDir)

	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("fake image bytes")...)
	var shotDir string
	fake.SetChatHook(func(req claude.RunRequest) {
		if req.MCPConfig == "" {
			return
		}
		shotDir = req.AddDirs[len(req.AddDirs)-1]
		_ = os.WriteFile(filepath.Join(shotDir, "admin.png"), png, 0o644)
		_ = os.WriteFile(filepath.Join(shotDir, "notes.txt"), []byte("not an image"), 0o644)
	})
	fake.SetChatTurns(`{"type":"need_write"}`, "Hier is de screenshot.")
	msg, _ := runOneClaudeTurn(ctx, m, cm, fake, dataDir, chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Draai de containers en maak een screenshot", TurnID: "msg-shots",
	})

	if len(fake.Calls) != 2 {
		t.Fatalf("expected 2 RunChat calls, got %d", len(fake.Calls))
	}
	shell := fake.Calls[1]
	hasMCP := false
	for _, tool := range shell.Tools {
		if tool == "mcp__playwright" {
			hasMCP = true
		}
	}
	if !hasMCP || !strings.Contains(shell.MCPConfig, "@playwright/mcp") || !strings.Contains(shell.MCPConfig, shotDir) {
		t.Fatalf("expected Playwright MCP with the screenshot dir on the shell attempt, got tools=%v mcp=%q", shell.Tools, shell.MCPConfig)
	}
	if strings.HasPrefix(shotDir, checkoutDir) {
		t.Fatalf("screenshot dir %q must live outside the checkout %q", shotDir, checkoutDir)
	}
	if len(msg.Attachments) != 1 || msg.Attachments[0].MIME != "image/png" || msg.Attachments[0].Name != "admin.png" {
		t.Fatalf("expected exactly the one png as attachment, got %+v", msg.Attachments)
	}
	path, ok := chatAttachmentPath(m.appDataDirOrDefault(), commentID, msg.Attachments[0].ID)
	if !ok {
		t.Fatalf("invalid attachment id %q", msg.Attachments[0].ID)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected the screenshot copied into the attachment store: %v", err)
	}
	if _, err := os.Stat(shotDir); !os.IsNotExist(err) {
		t.Fatalf("expected the per-turn screenshot dir to be removed, stat err=%v", err)
	}

	// An ordinary write turn: no browser.
	fake.SetChatHook(nil)
	fake.SetChatTurns(`{"type":"need_write"}`, "Aangepast.")
	_, _ = runOneClaudeTurn(ctx, m, cm, fake, dataDir, chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Pas foo.txt aan", TurnID: "msg-plain",
	})
	last := fake.Calls[len(fake.Calls)-1]
	if last.MCPConfig != "" {
		t.Fatalf("expected no MCP on a non-screenshot turn, got %q", last.MCPConfig)
	}
}
