// chat_screenshots.go — "draai de containers en maak een screenshot": a review
// chat turn (claude_chat, chat_workflow.go) may drive a real browser through
// Playwright MCP and its screenshots show up under Claude's own bubble.
//
// Reviewer request, verbatim: "ik wil dat ik aan de claude chat kan vragen om
// containers te draaien en zo screenshots te kunnen maken. die screenshots
// moeten zichtbaar zijn in de chat".
//
// The pieces:
//
//  1. Containers need nothing new: the escalated shell attempt already has
//     Bash in the reviewer's own checkout (the chat-turn carve-out in
//     .claude/rules/workflows-write-boundary.md), so `docker compose up -d`
//     works; chat_shell.md tells it the same stack rules qa_run.md uses.
//  2. The browser is Playwright MCP, loaded ONLY on the shell attempt and ONLY
//     when the reviewer's message looks like a screenshot/container request
//     (wantsChatScreenshots — a deterministic keyword match, reviewer decision:
//     every other write turn must not pay the MCP start-up and tool-schema
//     tokens). Same flags as qaMCPConfig (qa_run.go).
//  3. Screenshots land in a per-turn directory OUTSIDE the checkout (inside it
//     the landing check would see them as a change and commit them). After the
//     turn, harvestChatScreenshots copies every image there into the
//     conversation's ordinary attachment store (chat_attachment.go) and hangs
//     the refs on the assistant message — messageAttachments
//     (src/chatAttachments.mjs) already renders any message's attachments,
//     lightbox included. The per-turn directory is removed afterwards.
//
// Everything here runs inside runOneClaudeTurn's Activity, so the write
// boundary holds; the event history only ever sees the small refs.
package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"slash/modules/chat"
)

// chatScreenshotsPerTurn caps how many screenshots one assistant turn shows.
const chatScreenshotsPerTurn = 8

// chatScreenshotKeywords are lowercase substrings; one hit in the reviewer's
// message loads Playwright MCP on the shell attempt. Deliberately broad
// (Dutch + English): a false positive only costs one MCP start-up, a false
// negative means Claude cannot take the screenshot it was asked for.
var chatScreenshotKeywords = []string{
	"screenshot", "screen shot", "schermafbeelding", "schermafdruk", "schermopname",
	"printscreen", "container", "docker", "playwright", "browser",
}

// wantsChatScreenshots reports whether body looks like a request to run the
// stack or take screenshots. Pure and deterministic: a case-insensitive
// substring match against chatScreenshotKeywords.
func wantsChatScreenshots(body string) bool {
	lower := strings.ToLower(body)
	for _, kw := range chatScreenshotKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// chatScreenshotDir is ONE turn's screenshot directory. Absolute for the same
// reason as qaRunDir: Claude and the MCP run with the checkout as cwd. Both
// segments go through chatAttachmentConvDirName, so no caller-supplied string
// reaches a path verbatim.
func chatScreenshotDir(appDataDir, conversationID, turnID string) string {
	dir := filepath.Join(appDataDir, "chat-shots", chatAttachmentConvDirName(conversationID), chatAttachmentConvDirName(turnID))
	if abs, err := filepath.Abs(dir); err == nil {
		return abs
	}
	return dir
}

// chatScreenshotMCPConfig is the --mcp-config JSON for a screenshot turn:
// Playwright only (no laravel-boost — the chat has Bash for artisan), with the
// same flags qaMCPConfig uses.
func chatScreenshotMCPConfig(dir string) string {
	cfg := map[string]any{"mcpServers": map[string]any{
		"playwright": map[string]any{
			"command": "npx",
			"args": []string{"-y", "@playwright/mcp@latest", "--headless", "--isolated",
				"--ignore-https-errors", "--allow-unrestricted-file-access",
				"--test-id-attribute", "data-test", "--viewport-size", "1440x900",
				"--output-dir", dir},
		},
	}}
	out, _ := json.Marshal(cfg)
	return string(out)
}

// chatScreenshotPromptNote tells the shell attempt where screenshots go.
func chatScreenshotPromptNote(dir string) string {
	return fmt.Sprintf("\n\nJe hebt deze beurt een browser (Playwright MCP). Screenshotmap (absoluut pad, gebruik dit in elke `filename`): %s\n"+
		"Elke afbeelding in die map wordt na je antwoord automatisch onder je bericht in de chat getoond (maximaal %d).", dir, chatScreenshotsPerTurn)
}

// harvestChatScreenshots copies every supported image under dir (recursively,
// oldest first, at most chatScreenshotsPerTurn) into the conversation's
// attachment store and returns the refs for the assistant message. A file
// that is not a supported image or too large is skipped silently — a turn
// missing one screenshot is worth more than a failed turn.
func harvestChatScreenshots(appDataDir, conversationID, dir string) []chat.Attachment {
	type shot struct {
		path string
		mod  time.Time
	}
	var shots []shot
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil || info.Size() == 0 || info.Size() > chatAttachmentMaxBytes {
			return nil
		}
		shots = append(shots, shot{path: path, mod: info.ModTime()})
		return nil
	})
	sort.SliceStable(shots, func(i, j int) bool {
		if !shots[i].mod.Equal(shots[j].mod) {
			return shots[i].mod.Before(shots[j].mod)
		}
		return shots[i].path < shots[j].path
	})
	var out []chat.Attachment
	seen := map[string]bool{}
	for _, s := range shots {
		if len(out) >= chatScreenshotsPerTurn {
			break
		}
		data, err := os.ReadFile(s.path)
		if err != nil {
			continue
		}
		ref, err := storeChatAttachmentBytes(appDataDir, conversationID, filepath.Base(s.path), data)
		if err != nil || seen[ref.ID] {
			continue
		}
		seen[ref.ID] = true
		out = append(out, chat.Attachment{ID: ref.ID, Name: ref.Name, MIME: ref.MIME})
	}
	return out
}
