package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"

	"slash/modules/chat"
)

// chat_attachment.go — an image the reviewer pastes or drags into a Claude
// chat composer.
//
// Reviewer request, verbatim: "zorg ervoor dat ik ook afbeeldingen in de chat
// kan meegeven. zo kan ik soms een afbeelding vanuit clipboard hebben of een
// afbeelding slepen vanuit finder". One mechanism serves BOTH chats that exist
// — the review tree's per-line/PR conversation (claude_chat, chat_workflow.go)
// and the planning page's own ticket chat (the plan tracker's "chat" Kind,
// plan_workflow.go) — because the two only differ in how the file's PATH
// reaches the prompt, not in how the file gets stored or shown.
//
// THE WRITE BOUNDARY IS WHY THIS IS A WORKFLOW AND NOT AN UPLOAD HANDLER.
// A pasted screenshot is durable state: the reviewer's own bubble renders it
// again days later, and the turn that reads it may run minutes after the
// paste. That rules out the /api/transcribe shape (an HTTP handler writing a
// temp file it deletes again within the same request, see whisper.go's own
// WRITE BOUNDARY note) — per .claude/rules/workflows-write-boundary.md the
// bytes have to land through an Activity. Hence WorkflowChatAttachment: one
// input, one Activity, no signals, no clock, no loop.
//
// WHY THE BYTES DO NOT TRAVEL THROUGH THE CONVERSATION'S OWN SIGNAL.
// The obvious alternative — base64 on ChatMessageSignal — would put megabytes
// into the claude_chat run's event history, which tembed REPLAYS from the
// beginning on every single later turn (see .claude/rules/workflow-determinism.md).
// So the upload is its own short-lived Execution and the conversation's Signal
// carries only a ChatAttachmentRef: an id, a display name, a mime type. The
// long-lived run's history stays small no matter how many screenshots a
// reviewer pastes.
//
// WHAT CLAUDE ACTUALLY RECEIVES. Nothing multimodal is bolted onto the CLI
// bridge: the turn's prompt gets one extra line naming the ABSOLUTE paths, and
// Claude reads them with its own Read tool, which renders an image as real
// vision input. The only plumbing that needs adding is `--add-dir` (see
// RunRequest.AddDirs in modules/claude), because the attachments live next to
// the DBs rather than inside the worktree the turn runs in.
//
// See .claude/docs/claude-chat-panel.md ("Afbeeldingen meesturen") for the
// whole chain, the UI half included.

const (
	// chatAttachmentMaxBytes caps ONE image. A macOS screenshot of a 5K
	// display is comfortably under this; anything larger is refused rather
	// than base64'd through the browser, the handler and an Activity.
	chatAttachmentMaxBytes = 10 << 20 // 10 MiB

	// chatAttachmentsPerMessage caps how many images one reviewer turn may
	// carry. Enforced in the UI (the composer stops accepting) and again on
	// the message Signal, so a hand-rolled POST cannot hand the prompt an
	// unbounded list of paths.
	chatAttachmentsPerMessage = 5

	// chatAttachmentMaxAge is how long an attachment survives with nothing
	// touching it — swept by the cleanup workflow (see sweepChatAttachments),
	// the same age-based residue shape workflows-test-run.md already uses.
	// Long enough that re-reading an old conversation still shows its images,
	// short enough that a year of pasted screenshots doesn't pile up in
	// data/.
	chatAttachmentMaxAge = 90 * 24 * time.Hour
)

// ChatAttachmentRef is what a stored attachment looks like everywhere OUTSIDE
// this file: on the message Signal, in the saved chat message, and in the JSON
// the UI reads back. Deliberately no bytes and no path — the id plus the
// conversation is enough to rebuild both (see chatAttachmentPath).
type ChatAttachmentRef struct {
	// ID is "<sha256 of the bytes>.<ext>", minted by the Activity below. The
	// content hash means the same screenshot pasted twice costs one file, and
	// it makes the id unguessable-by-accident and free of anything a caller
	// chose — validChatAttachmentID is therefore a very tight regexp.
	ID string `json:"id"`
	// Name is the original file name, for display only ("schermafdruk.png").
	// Never used to build a path.
	Name string `json:"name,omitempty"`
	// MIME is the type SNIFFED from the bytes (not the one the browser
	// claimed), so it always matches what /api/chat/attachment will serve.
	MIME string `json:"mime,omitempty"`
}

// ChatAttachmentInput is the chat_attachment Execution's whole input: one
// image, base64-encoded, plus the conversation it belongs to.
type ChatAttachmentInput struct {
	// ConversationID is the claude_chat conversation id (== the comment
	// thread's id) or the planning page's own chat conversation id
	// (planChatConversationID). Only ever used through
	// chatAttachmentConvDirName, which hashes it into a safe directory name,
	// so no caller-supplied string ever reaches a path segment verbatim.
	ConversationID string `json:"conversationId"`
	Name           string `json:"name,omitempty"`
	Data           string `json:"data"` // base64, no "data:" prefix
}

// chatAttachmentExts maps a sniffed image type onto the extension the stored
// file gets — and, read the other way, is the allowlist deciding what
// /api/chat/attachment is willing to serve. Deliberately the same set (minus
// .ico, which nobody pastes into a chat) as image_asset.go's own
// imageContentTypes: one idea, one allowlist shape.
var chatAttachmentExts = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
	"image/avif": ".avif",
}

// chatAttachmentTypeByExt is the reverse map, used when serving a stored file.
var chatAttachmentTypeByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
}

// chatAttachmentIDRe is the ONLY shape a stored attachment id may have: a full
// sha256 hex digest plus one allowlisted extension. Nothing else can even be
// spelled — no separator, no dot-dot, no absolute path — so a hostile id
// cannot walk out of its conversation directory before the file is opened.
var chatAttachmentIDRe = regexp.MustCompile(`^[0-9a-f]{64}\.(png|jpg|gif|webp|avif)$`)

// sniffChatAttachmentType reports the image type of data by its MAGIC BYTES,
// or "" when it is not one of the allowlisted images.
//
// The browser's own claimed MIME (and the file name's extension) are
// deliberately NOT trusted: they are attacker/mistake-controlled strings, and
// the extension the file gets on disk — plus the Content-Type it is later
// served with — must be derived from what the bytes actually are, so those two
// can never disagree. Same reasoning as the extension allowlist in
// image_asset.go, one step stricter.
func sniffChatAttachmentType(data []byte) string {
	switch {
	case len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return "image/jpeg"
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		return "image/gif"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp"
	case len(data) >= 12 && string(data[4:8]) == "ftyp" &&
		(string(data[8:12]) == "avif" || string(data[8:12]) == "avis"):
		return "image/avif"
	}
	return ""
}

// chatAttachmentsRoot is the one directory every conversation's images live
// under, next to the DBs — always ABSOLUTE.
//
// The server's data dir defaults to the relative "data" (dataDirPath,
// main.go), but the path built here reaches a claude turn that runs with a
// DIFFERENT cwd: the PR's head worktree or the reviewer's own assigned
// checkout (prepareChatReadOnlyWorkDir). A relative path in the prompt note
// (and in --add-dir, which the CLI resolves against its own cwd) then points
// into that checkout, where the file does not exist — measured: Claude
// answered "bestaat niet in de werkkopie" while the image sat under the
// slash repo's own data/. Resolving it here, against the SERVER's cwd, keeps
// the same directory on disk and fixes every reader at once.
func chatAttachmentsRoot(dataDir string) string {
	root := filepath.Join(dataDir, "chat-attachments")
	if abs, err := filepath.Abs(root); err == nil {
		return abs
	}
	return root
}

// chatAttachmentConvDirName turns a conversation id into ONE safe path
// segment: every character outside [A-Za-z0-9._-] becomes '_', with a short
// hash of the ORIGINAL appended so two different ids can never collapse onto
// the same directory. The readable half is only there so the directory listing
// still tells a human which conversation it belongs to; the hash is what makes
// it correct, and it also guarantees the segment is never empty, "." or "..".
func chatAttachmentConvDirName(conversationID string) string {
	var b strings.Builder
	for _, r := range conversationID {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	readable := b.String()
	if len(readable) > 48 {
		readable = readable[:48]
	}
	sum := sha256.Sum256([]byte(conversationID))
	return readable + "-" + hex.EncodeToString(sum[:])[:8]
}

// chatAttachmentConvDir is where ONE conversation's images live.
func chatAttachmentConvDir(dataDir, conversationID string) string {
	return filepath.Join(chatAttachmentsRoot(dataDir), chatAttachmentConvDirName(conversationID))
}

// chatAttachmentPath resolves one stored attachment to its absolute path, or
// reports !ok when the id is not the exact shape chatAttachmentIDRe allows.
// Every reader (the serve handler, the prompt builder) goes through this, so
// the id validation cannot be forgotten at one call site.
func chatAttachmentPath(dataDir, conversationID, id string) (string, bool) {
	if conversationID == "" || !chatAttachmentIDRe.MatchString(id) {
		return "", false
	}
	return filepath.Join(chatAttachmentConvDir(dataDir, conversationID), id), true
}

// existingChatAttachmentPaths maps refs onto the absolute paths that really
// exist on disk — what the prompt line is built from. A ref whose file is gone
// (swept, or a hand-rolled Signal naming something that was never stored) is
// silently skipped: a turn missing one image is worth strictly more than a
// failed turn.
func existingChatAttachmentPaths(dataDir, conversationID string, refs []ChatAttachmentRef) []string {
	var out []string
	for _, ref := range refs {
		path, ok := chatAttachmentPath(dataDir, conversationID, ref.ID)
		if !ok {
			continue
		}
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			continue
		}
		out = append(out, path)
	}
	return out
}

// chatAttachmentPromptNote is the one extra line a turn's prompt gets when the
// reviewer attached images: the absolute paths, plus the instruction to LOOK at
// them. Claude's own Read tool renders an image as vision input, so nothing
// else is needed — see this file's header.
//
// Empty string when there is nothing to attach, so every call site can append
// it unconditionally.
func chatAttachmentPromptNote(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\nDe reviewer heeft ")
	if len(paths) == 1 {
		b.WriteString("een afbeelding")
	} else {
		fmt.Fprintf(&b, "%d afbeeldingen", len(paths))
	}
	b.WriteString(" meegestuurd bij dit bericht. Bekijk ")
	if len(paths) == 1 {
		b.WriteString("die eerst met het Read-gereedschap")
	} else {
		b.WriteString("die eerst allemaal met het Read-gereedschap")
	}
	b.WriteString(" — het hoort bij de vraag hierboven:\n")
	for _, p := range paths {
		fmt.Fprintf(&b, "- %s\n", p)
	}
	return b.String()
}

// removeChatAttachments drops everything one conversation stored. Called when
// the reviewer wipes that conversation ("wis gesprek", chatActionClear): the
// transcript that referenced these images is gone, so the images are residue.
// Best-effort — a failure here never fails the clear itself.
func removeChatAttachments(dataDir, conversationID string) {
	if dataDir == "" || conversationID == "" {
		return
	}
	_ = os.RemoveAll(chatAttachmentConvDir(dataDir, conversationID))
}

// sweepChatAttachments removes every conversation directory whose NEWEST file
// is older than maxAge, and reports how many it removed. Age-based rather than
// reference-counted on purpose: the two chats that store these keep their
// transcripts in two different places (a SQLite read-model and a plan
// document), and neither is authoritative about the other's — a sweep that had
// to consult both would be the only code in the app needing to know that.
// Same shape as the test_run residue sweep (.claude/docs/workflows-test-run.md).
func sweepChatAttachments(dataDir string, now time.Time, maxAge time.Duration) int {
	root := chatAttachmentsRoot(dataDir)
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		newest := time.Time{}
		for _, f := range files {
			info, err := f.Info()
			if err != nil {
				continue
			}
			if info.ModTime().After(newest) {
				newest = info.ModTime()
			}
		}
		if newest.IsZero() || now.Sub(newest) > maxAge {
			if os.RemoveAll(dir) == nil {
				removed++
			}
		}
	}
	return removed
}

// chatAttachmentWorkflow is the whole Execution: one Activity, no signals, no
// clock, no loop — the same strictest-sense one-shot shape as
// whisperModelWorkflow. Its RESULT is the stored ref, which the start handler
// reads back with Engine.Result and hands to the browser.
func chatAttachmentWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ChatAttachmentInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	var ref ChatAttachmentRef
	if err := w.ExecuteActivity("saveChatAttachment", in, &ref); err != nil {
		return nil, fmt.Errorf("save chat attachment: %w", err)
	}
	return json.Marshal(ref)
}

// saveChatAttachment is that Activity: decode, verify by magic bytes, write.
// The file name is the content hash, so writing the same image twice is
// idempotent — which is also what makes the Activity safe to re-run on a
// replay/recovery.
func (m *TaskManager) saveChatAttachment(ctx context.Context, in ChatAttachmentInput) (ChatAttachmentRef, error) {
	if in.ConversationID == "" {
		return ChatAttachmentRef{}, fmt.Errorf("chat attachment: missing conversation")
	}
	data, err := base64.StdEncoding.DecodeString(in.Data)
	if err != nil {
		return ChatAttachmentRef{}, fmt.Errorf("chat attachment: invalid base64: %w", err)
	}
	if len(data) == 0 {
		return ChatAttachmentRef{}, fmt.Errorf("chat attachment: empty file")
	}
	if len(data) > chatAttachmentMaxBytes {
		return ChatAttachmentRef{}, fmt.Errorf("chat attachment: too large (%s)", humanBytes(len(data)))
	}
	mime := sniffChatAttachmentType(data)
	if mime == "" {
		return ChatAttachmentRef{}, fmt.Errorf("chat attachment: not a supported image")
	}
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:]) + chatAttachmentExts[mime]
	// appDataDirOrDefault, never m.dataDir: an attachment is app content the
	// read-only GET serves out of server.dataDir (api.go), and those two dirs
	// only coincide by default — a run that points -db and -data at different
	// trees (every Playwright worker does) would otherwise write where nothing
	// ever reads. Same reasoning, and the same call, as the app_settings
	// Activities that write settings.json.
	dir := chatAttachmentConvDir(m.appDataDirOrDefault(), in.ConversationID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ChatAttachmentRef{}, fmt.Errorf("chat attachment: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, id), data, 0o644); err != nil {
		return ChatAttachmentRef{}, fmt.Errorf("chat attachment: %w", err)
	}
	return ChatAttachmentRef{ID: id, Name: chatAttachmentDisplayName(in.Name, id), MIME: mime}, nil
}

// chatAttachmentDisplayName keeps the reviewer's own file name for display,
// trimmed of anything that could read as a path and capped in length. Falls
// back to the id when there is nothing usable left — the name is decoration,
// never an identifier.
func chatAttachmentDisplayName(name, id string) string {
	name = strings.TrimSpace(filepath.Base(strings.ReplaceAll(name, "\\", "/")))
	if name == "" || name == "." || name == ".." {
		return id
	}
	if len(name) > 80 {
		name = name[:80]
	}
	return name
}

// handleChatAttachmentStart serves POST /api/workflows/chat_attachment
// {conversationId, name, data} — the ONE write path for an attachment, per the
// write boundary. Everything that can be checked without touching the disk is
// checked HERE, before an Execution exists (validate-before-exec); the bytes
// themselves are verified in the Activity, which is the only place that has
// them decoded.
//
// The start is synchronous for a workflow with no live low-priority activity
// (see tembed's StartWorkflow), so by the time this returns the file is on
// disk and Engine.Result can hand its id straight back to the browser.
func (s *server) handleChatAttachmentStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// The base64 of a 10 MiB image is ~13.4 MiB; the slack on top of that is
	// for the JSON envelope. A body bigger than this is refused before it is
	// ever read into memory.
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	var in ChatAttachmentInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "invalid attachment", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(in.ConversationID) == "" || in.Data == "" {
		http.Error(w, "invalid attachment", http.StatusBadRequest)
		return
	}
	// Everything about the BYTES is judged here, before an Execution exists —
	// not only because of the validate-before-exec rule, but because a refusal
	// inside the Activity would fail the run, and a failed run is reported to
	// the reviewer for four days in the global "mislukte taken" dialog
	// (run_errors.go). Refusing a .txt or a 30 MB photo is an ordinary,
	// expected answer to a paste, never an incident: it belongs in this
	// endpoint's 400, with nothing left behind. The Activity keeps its own
	// identical checks as a backstop for any other caller.
	if msg, ok := chatAttachmentRejection(in.Data); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}
	runID, err := s.tasks.engine.StartWorkflow(WorkflowChatAttachment, in)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	var ref ChatAttachmentRef
	if err := s.tasks.engine.Result(runID, &ref); err != nil || ref.ID == "" {
		msg := "kon de afbeelding niet opslaan"
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, ref)
}

// chatAttachmentRejection judges one base64 payload the way the Activity will,
// and returns the reviewer-facing reason when it would be refused. Shares the
// exact same three checks (decodable, size, magic bytes) so the handler and the
// Activity can never disagree about what is acceptable.
func chatAttachmentRejection(data string) (string, bool) {
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return "de afbeelding kon niet worden gelezen", false
	}
	if len(raw) == 0 {
		return "de afbeelding is leeg", false
	}
	if len(raw) > chatAttachmentMaxBytes {
		return "de afbeelding is te groot (" + humanBytes(len(raw)) + ", max " + humanBytes(chatAttachmentMaxBytes) + ")", false
	}
	if sniffChatAttachmentType(raw) == "" {
		return "dit is geen ondersteunde afbeelding", false
	}
	return "", true
}

// handleChatAttachment serves GET /api/chat/attachment?conv=<id>&id=<file> —
// the raw bytes of one stored attachment, so the reviewer's own bubble can
// render it in an <img>. Read-only, and guarded exactly like handleImage
// (image_asset.go): the extension allowlist decides the Content-Type, the
// browser is never allowed to sniff its own, and the id shape (see
// chatAttachmentPath) is the only thing that can name a file.
func (s *server) handleChatAttachment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	path, ok := chatAttachmentPath(s.dataDir, q.Get("conv"), q.Get("id"))
	if !ok {
		http.Error(w, "invalid attachment", http.StatusBadRequest)
		return
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		http.Error(w, "unknown attachment", http.StatusNotFound)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", chatAttachmentTypeByExt[strings.ToLower(filepath.Ext(path))])
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The id IS the content hash, so the bytes behind one URL can never change.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// validChatAttachmentRefs filters a Signal's attachment list down to what is
// actually acceptable: at most chatAttachmentsPerMessage entries, each with an
// id of the exact stored shape whose file really exists in THAT conversation's
// directory. Used by the two message handlers (tasks_api.go) so neither the
// chat workflow nor the plan tracker ever records a path-shaped surprise.
func (s *server) validChatAttachmentRefs(conversationID string, refs []ChatAttachmentRef) ([]ChatAttachmentRef, bool) {
	if len(refs) == 0 {
		return nil, true
	}
	if len(refs) > chatAttachmentsPerMessage {
		return nil, false
	}
	out := make([]ChatAttachmentRef, 0, len(refs))
	for _, ref := range refs {
		path, ok := chatAttachmentPath(s.dataDir, conversationID, ref.ID)
		if !ok {
			return nil, false
		}
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return nil, false
		}
		out = append(out, ChatAttachmentRef{
			ID:   ref.ID,
			Name: chatAttachmentDisplayName(ref.Name, ref.ID),
			MIME: chatAttachmentTypeByExt[strings.ToLower(filepath.Ext(ref.ID))],
		})
	}
	return out, true
}

// chatAttachmentsForMessage converts the Signal's refs into the read-model's
// own shape, so the reviewer's stored bubble carries exactly what was sent.
// Two structs rather than one shared type because modules/chat may not import
// the main package; the JSON shape is identical, which is what the browser
// sees.
func chatAttachmentsForMessage(refs []ChatAttachmentRef) []chat.Attachment {
	if len(refs) == 0 {
		return nil
	}
	out := make([]chat.Attachment, 0, len(refs))
	for _, ref := range refs {
		out = append(out, chat.Attachment{ID: ref.ID, Name: ref.Name, MIME: ref.MIME})
	}
	return out
}

// chatConversationForRun is the inverse of chatConversationRunID: which
// conversation a claude_chat Run ID belongs to. Used by the message-Signal
// handler to scope an attachment id to the conversation it was uploaded for,
// so a valid id from conversation A can never be attached to a turn of
// conversation B. A run id of any other shape yields "" — which
// validChatAttachmentRefs then rejects any non-empty attachment list against.
func (m *TaskManager) chatConversationForRun(runID string) string {
	if !strings.HasPrefix(runID, "chat-") {
		return ""
	}
	return strings.TrimPrefix(runID, "chat-")
}

// chatAttachmentOnlyBody is the placeholder body a turn gets when the reviewer
// sent nothing but images (drag/paste + Enter, deliberately allowed — see the
// message-Signal handler). It is what their own bubble shows above the
// thumbnails, and what Claude reads as the message text; the prompt's own
// attachment note (chatAttachmentPromptNote) supplies the rest.
func chatAttachmentOnlyBody(n int) string {
	if n > 1 {
		return "(afbeeldingen)"
	}
	return "(afbeelding)"
}

// planChatAttachments validates a planning-page chat message's attachments
// against the conversation THAT PLAN's chat owns. The plan tracker's Run ID
// embeds the Jira key (planRunID), and the chat's conversation id is derived
// from that same key (planChatConversationID), so the browser never has to
// name the conversation and cannot name a different one. A run id of any other
// shape yields "", which rejects every non-empty attachment list.
func (s *server) planChatAttachments(runID string, refs []ChatAttachmentRef) ([]ChatAttachmentRef, bool) {
	conversationID := ""
	if key := strings.TrimPrefix(runID, "plan-"); key != runID && key != "" {
		conversationID = planChatConversationID(key)
	}
	return s.validChatAttachmentRefs(conversationID, refs)
}
