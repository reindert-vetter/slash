package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestSaveChatAttachmentVerifiesTheBytes pins the Activity's contract: the
// stored file's name and type come from what the bytes REALLY are, never from
// what the caller claimed, and anything that is not one of the allowlisted
// images is refused outright.
func TestSaveChatAttachmentVerifiesTheBytes(t *testing.T) {
	m := &TaskManager{dataDir: t.TempDir()}
	const conv = "gh-12345"

	ref, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv,
		Name:           "Schermafbeelding 2026.png",
		Data:           base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x01))),
	})
	if err != nil {
		t.Fatalf("saveChatAttachment: %v", err)
	}
	if !chatAttachmentIDRe.MatchString(ref.ID) {
		t.Errorf("id = %q, want <sha256>.png", ref.ID)
	}
	if ref.MIME != "image/png" {
		t.Errorf("mime = %q, want image/png (sniffed, not claimed)", ref.MIME)
	}
	if ref.Name != "Schermafbeelding 2026.png" {
		t.Errorf("name = %q, want the reviewer's own file name", ref.Name)
	}
	path, ok := chatAttachmentPath(m.dataDir, conv, ref.ID)
	if !ok {
		t.Fatalf("chatAttachmentPath refused the id it just minted")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != tinyPNG(0x01) {
		t.Errorf("stored bytes = %q (err %v), want the original image", data, err)
	}

	// Content-addressed: the same image twice is one file, same id.
	again, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv, Name: "kopie.png",
		Data: base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x01))),
	})
	if err != nil || again.ID != ref.ID {
		t.Errorf("same image again = %q (err %v), want the same id %q", again.ID, err, ref.ID)
	}

	// A file name claiming to be a PNG does not make it one.
	if _, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv, Name: "evil.png",
		Data: base64.StdEncoding.EncodeToString([]byte("<?php system($_GET['c']); ?>")),
	}); err == nil {
		t.Errorf("a PHP file named .png was accepted, want a refusal")
	}

	// Oversized is refused before anything is written.
	if _, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv,
		Data:           base64.StdEncoding.EncodeToString(append([]byte(tinyPNG(0x01)), make([]byte, chatAttachmentMaxBytes)...)),
	}); err == nil {
		t.Errorf("an oversized image was accepted, want a refusal")
	}
}

// TestChatAttachmentStartRefusesBeforeStartingARun pins the reason the byte
// checks are duplicated in the handler: a refused paste (wrong type, too big)
// is an ordinary answer, not an incident — it must never leave a FAILED run
// behind, which the global "mislukte taken" dialog would then report for four
// days (run_errors.go).
func TestChatAttachmentStartRefusesBeforeStartingARun(t *testing.T) {
	for name, data := range map[string]string{
		"not an image": base64.StdEncoding.EncodeToString([]byte("<?php echo 1;")),
		"empty":        base64.StdEncoding.EncodeToString(nil),
		"not base64":   "%%%not base64%%%",
		"too large": base64.StdEncoding.EncodeToString(
			append([]byte(tinyPNG(0x01)), make([]byte, chatAttachmentMaxBytes)...)),
	} {
		if msg, ok := chatAttachmentRejection(data); ok {
			t.Errorf("%s was accepted, want a refusal", name)
		} else if msg == "" {
			t.Errorf("%s: refused without a reason for the reviewer", name)
		}
	}
	if msg, ok := chatAttachmentRejection(base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x02)))); !ok {
		t.Errorf("a real PNG was refused: %s", msg)
	}
}

// TestChatAttachmentPathRejectsAnythingButAStoredID is the security half: the
// id is the ONLY caller-supplied part of the path, so every shape other than
// "<sha256>.<allowed ext>" must be refused before a file is ever opened.
func TestChatAttachmentPathRejectsAnythingButAStoredID(t *testing.T) {
	dir := t.TempDir()
	valid := strings.Repeat("a", 64) + ".png"
	if _, ok := chatAttachmentPath(dir, "conv", valid); !ok {
		t.Fatalf("a well-formed id was refused")
	}
	for name, id := range map[string]string{
		"traversal":      "../../../../etc/hosts.png",
		"absolute":       "/etc/hosts.png",
		"separator":      "sub/" + valid,
		"wrong ext":      strings.Repeat("a", 64) + ".php",
		"short hash":     "abc.png",
		"uppercase hash": strings.Repeat("A", 64) + ".png",
		"empty":          "",
	} {
		if _, ok := chatAttachmentPath(dir, "conv", id); ok {
			t.Errorf("%s (%q) was accepted, want a refusal", name, id)
		}
	}
	// No conversation is no path either.
	if _, ok := chatAttachmentPath(dir, "", valid); ok {
		t.Errorf("an empty conversation was accepted")
	}
	// Two different conversations never share a directory, however
	// path-unfriendly their ids are.
	if chatAttachmentConvDirName("plan:PAYM-813") == chatAttachmentConvDirName("plan:PAYM-814") {
		t.Errorf("two conversations collapsed onto one directory")
	}
	if strings.ContainsAny(chatAttachmentConvDirName("../../etc"), "/\\") {
		t.Errorf("a conversation id leaked path separators into its directory name")
	}
}

// TestHandleChatAttachmentServesStoredBytes covers the read endpoint: the
// stored bytes with the allowlisted Content-Type, and a refusal for every way
// the query could try to reach something else.
func TestHandleChatAttachmentServesStoredBytes(t *testing.T) {
	dataDir := t.TempDir()
	m := &TaskManager{dataDir: dataDir}
	const conv = "gh-999"
	ref, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv, Name: "shot.png",
		Data: base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x07))),
	})
	if err != nil {
		t.Fatalf("saveChatAttachment: %v", err)
	}

	s := &server{dataDir: dataDir}
	get := func(query string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		s.handleChatAttachment(rr, httptest.NewRequest(http.MethodGet, "/api/chat/attachment?"+query, nil))
		return rr
	}

	rr := get("conv=" + conv + "&id=" + ref.ID)
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rr.Code)
	}
	if rr.Body.String() != tinyPNG(0x07) {
		t.Errorf("served the wrong bytes")
	}
	if ct := rr.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	if rr.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("missing nosniff")
	}

	for name, query := range map[string]string{
		"traversal":            "conv=" + conv + "&id=../../../etc/hosts.png",
		"another conversation": "conv=gh-1&id=" + ref.ID,
		"no conversation":      "id=" + ref.ID,
		"unknown id":           "conv=" + conv + "&id=" + strings.Repeat("b", 64) + ".png",
	} {
		if rr := get(query); rr.Code == http.StatusOK {
			t.Errorf("%s: got 200, want a refusal", name)
		}
	}
}

// TestValidChatAttachmentRefsScopesToItsConversation pins what the message
// Signal handlers rely on: an id is only acceptable for the conversation it
// was uploaded to, the list is capped, and the returned mime/name are the
// server's own (never the caller's claim).
func TestValidChatAttachmentRefsScopesToItsConversation(t *testing.T) {
	dataDir := t.TempDir()
	m := &TaskManager{dataDir: dataDir}
	const conv = "gh-42"
	ref, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv, Name: "a.png",
		Data: base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x03))),
	})
	if err != nil {
		t.Fatalf("saveChatAttachment: %v", err)
	}
	s := &server{dataDir: dataDir}

	got, ok := s.validChatAttachmentRefs(conv, []ChatAttachmentRef{{ID: ref.ID, Name: "../../evil", MIME: "text/html"}})
	if !ok || len(got) != 1 {
		t.Fatalf("a stored attachment was refused: ok=%v got=%+v", ok, got)
	}
	if got[0].MIME != "image/png" || strings.ContainsAny(got[0].Name, "/\\") {
		t.Errorf("caller-supplied mime/name survived: %+v", got[0])
	}
	if _, ok := s.validChatAttachmentRefs("gh-other", []ChatAttachmentRef{{ID: ref.ID}}); ok {
		t.Errorf("an attachment of another conversation was accepted")
	}
	many := make([]ChatAttachmentRef, chatAttachmentsPerMessage+1)
	for i := range many {
		many[i] = ChatAttachmentRef{ID: ref.ID}
	}
	if _, ok := s.validChatAttachmentRefs(conv, many); ok {
		t.Errorf("more than %d attachments were accepted", chatAttachmentsPerMessage)
	}
	// No attachments at all is always fine — that is the ordinary turn.
	if refs, ok := s.validChatAttachmentRefs(conv, nil); !ok || refs != nil {
		t.Errorf("an empty list was not accepted cleanly: ok=%v refs=%+v", ok, refs)
	}
}

// TestChatAttachmentPromptNoteNamesEveryExistingFile pins what actually
// reaches Claude: the absolute paths of the files that are really there, and
// nothing at all when there is nothing to show (so every call site can append
// it unconditionally).
func TestChatAttachmentPromptNoteNamesEveryExistingFile(t *testing.T) {
	dataDir := t.TempDir()
	m := &TaskManager{dataDir: dataDir}
	const conv = "gh-7"
	ref, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv, Data: base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x04))),
	})
	if err != nil {
		t.Fatalf("saveChatAttachment: %v", err)
	}

	gone := ChatAttachmentRef{ID: strings.Repeat("c", 64) + ".png"}
	paths := existingChatAttachmentPaths(dataDir, conv, []ChatAttachmentRef{ref, gone})
	if len(paths) != 1 || !strings.HasSuffix(paths[0], ref.ID) {
		t.Fatalf("paths = %v, want only the file that exists", paths)
	}
	note := chatAttachmentPromptNote(paths)
	if !strings.Contains(note, paths[0]) || !strings.Contains(note, "Read") {
		t.Errorf("prompt note = %q, want the absolute path plus the Read instruction", note)
	}
	if chatAttachmentPromptNote(nil) != "" {
		t.Errorf("an empty attachment list must add nothing to the prompt")
	}
}

// TestChatAttachmentPathsAreAbsoluteForARelativeDataDir pins the fix for a
// turn running outside the server's cwd (the reviewer's own checkout): the
// server's default data dir is the relative "data", yet the prompt note and
// --add-dir must name the image absolutely, or Claude resolves them inside
// that checkout and finds nothing.
func TestChatAttachmentPathsAreAbsoluteForARelativeDataDir(t *testing.T) {
	t.Chdir(t.TempDir())
	m := &TaskManager{dataDir: "data"}
	const conv = "gh-8"
	ref, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
		ConversationID: conv, Data: base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x05))),
	})
	if err != nil {
		t.Fatalf("saveChatAttachment: %v", err)
	}
	paths := existingChatAttachmentPaths("data", conv, []ChatAttachmentRef{ref})
	if len(paths) != 1 || !filepath.IsAbs(paths[0]) {
		t.Fatalf("paths = %v, want one absolute path", paths)
	}
	if dir := chatAttachmentConvDir("data", conv); !filepath.IsAbs(dir) {
		t.Errorf("conv dir = %q, want absolute (it becomes --add-dir)", dir)
	}
	// Still the same file on disk, just spelled absolutely.
	if _, err := os.Stat(filepath.Join("data", "chat-attachments", chatAttachmentConvDirName(conv), ref.ID)); err != nil {
		t.Errorf("file not under the relative data dir: %v", err)
	}
}

// TestSweepAndClearRemoveAttachments covers the two ways an attachment goes
// away again: wiping its conversation, and the cleanup workflow's age-based
// sweep.
func TestSweepAndClearRemoveAttachments(t *testing.T) {
	dataDir := t.TempDir()
	m := &TaskManager{dataDir: dataDir}
	const fresh, old = "gh-new", "gh-old"
	for _, conv := range []string{fresh, old} {
		if _, err := m.saveChatAttachment(context.Background(), ChatAttachmentInput{
			ConversationID: conv, Data: base64.StdEncoding.EncodeToString([]byte(tinyPNG(0x05))),
		}); err != nil {
			t.Fatalf("saveChatAttachment: %v", err)
		}
	}
	// Age the old one past the retention window.
	stale := time.Now().Add(-2 * chatAttachmentMaxAge)
	oldDir := chatAttachmentConvDir(dataDir, old)
	entries, _ := os.ReadDir(oldDir)
	for _, e := range entries {
		if err := os.Chtimes(filepath.Join(oldDir, e.Name()), stale, stale); err != nil {
			t.Fatalf("chtimes: %v", err)
		}
	}

	if n := sweepChatAttachments(dataDir, time.Now(), chatAttachmentMaxAge); n != 1 {
		t.Errorf("sweep removed %d directories, want 1", n)
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Errorf("the stale conversation's directory survived the sweep")
	}
	if _, err := os.Stat(chatAttachmentConvDir(dataDir, fresh)); err != nil {
		t.Errorf("the fresh conversation's directory was swept too: %v", err)
	}

	removeChatAttachments(dataDir, fresh)
	if _, err := os.Stat(chatAttachmentConvDir(dataDir, fresh)); !os.IsNotExist(err) {
		t.Errorf("wiping the conversation left its images behind")
	}
}
