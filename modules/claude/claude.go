// Package claude is the Claude-CLI bridge module: the one place that shells out
// to the local `claude` CLI (Anthropic's Claude Code) — originally to resolve a
// PHP method call to its definition, now also to run a multi-turn reviewer
// conversation (the claude_chat workflow). It is driven by workflow Activities
// — per the project rule, only workflows mutate state, and a module like this
// runs on their behalf (it performs a side effect: running a subprocess).
//
// It is deliberately domain-thin: Run executes one stateless completion and
// returns the model's final text; RunChat is its conversational sibling (a
// session id ties turns together via the CLI's own --session-id/--resume).
// Parsing that text into a resolution/message is the caller's job (the
// resolve_call/claude_chat workflows). This keeps the bridge reusable and
// testable via the Fake, which callers swap in under SLASH_CLAUDE=off so tests
// never hit the network.
package claude

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// contextTimeout/agenticTimeout bound a single `claude -p` invocation, applied
// by this module itself so a hung claude can never block a workflow run
// indefinitely — see modules/jira's cliTimeout doc comment for the full
// rationale (inline/blocking SignalWorkflow, "shorter deadline always wins",
// var-not-const purely for testability with a fake, slow binary).
//
// Two values, not one, because the two run shapes are genuinely different:
//   - contextTimeout (no Tools — a pure completion: resolve_call's Haiku pass,
//     explain_code, pr_status's summary) — tembed-workflows.md's own
//     recovery-priority notes call ~30s typical for these; 90s gives ~3x
//     headroom while still bounding it.
//   - agenticTimeout (Tools set — Sonnet/Opus exploring a worktree with
//     Read/Grep/Glob, e.g. code_warning's PR-wide risk check) may legitimately
//     run for minutes; 10 minutes is generous but finite, so a wedged tool
//     call/auth prompt still can't hang the workflow forever. If a real
//     agentic run turns out to need more than this in practice, raise it.
var (
	contextTimeout = 90 * time.Second
	agenticTimeout = 10 * time.Minute
)

// Full model IDs (see the claude-api reference).
const (
	ModelHaiku  = "claude-haiku-4-5"
	ModelSonnet = "claude-sonnet-5"
	ModelOpus   = "claude-opus-5"
)

// RunRequest is a single non-interactive `claude -p` invocation.
type RunRequest struct {
	Model   string   // full model id (ModelHaiku / ModelSonnet)
	Prompt  string   // the user prompt; the caller instructs the model to answer as JSON
	WorkDir string   // cwd for agentic runs (a checked-out worktree); "" falls back to Module.scratchDir
	Tools   []string // allowed read-only tools for agentic runs (e.g. Read, Grep, Glob); empty = no tools
	// SystemPrompt is static, call-independent instruction text appended via
	// `claude`'s --append-system-prompt (e.g. the embedded modules/claude/prompts/*.md
	// files). Keeping it out of Prompt lets it stay byte-identical across many
	// calls of the same action within a PR, which is what makes it eligible for
	// the CLI's own prompt caching; the varying, call-specific content (caller
	// body, candidates, selected code, PR metadata) stays in Prompt. "" appends
	// nothing.
	SystemPrompt string
	// SessionID is read only by RunChat (Run always makes a stateless one-shot
	// call and ignores it). Empty starts a brand-new session (RunChat picks a
	// fresh UUID and passes it via --session-id so the caller learns it back
	// through ChatResult.SessionID); non-empty resumes that existing session via
	// --resume, so the CLI/backend keeps the prior turns' context without this
	// module having to resend the whole transcript itself.
	SessionID string
	// OnEvent, when non-nil, is called by RunChat for every interesting frame
	// the CLI streams while the turn is still running (see ChatEvent). It is
	// PURELY OBSERVATIONAL: it can never change what RunChat returns, and it is
	// deliberately a Go func rather than data, so it is structurally impossible
	// for it to end up in a workflow Activity's recorded input — the durable
	// result of a turn stays a pure function of that input, per
	// .claude/rules/workflow-determinism.md. Calls are made serially from
	// RunChat's own single reading goroutine, so a callback needs no locking of
	// its own for state it alone touches.
	OnEvent func(ChatEvent)
}

// ChatEventKind labels what a streamed ChatEvent reports. Deliberately a tiny,
// UI-shaped vocabulary rather than a 1-to-1 mirror of the CLI's own frame
// zoo — everything this app wants to say is "Claude is thinking / writing /
// using tool X", plus the growing answer text.
type ChatEventKind string

const (
	ChatEventStatus   ChatEventKind = "status"   // the turn started (session initialised)
	ChatEventThinking ChatEventKind = "thinking" // extended-thinking tokens (content deliberately NOT forwarded)
	ChatEventText     ChatEventKind = "text"     // one delta of the visible answer (TextDelta)
	ChatEventTool     ChatEventKind = "tool"     // the model invoked a tool (Tool, plus a short Detail)
)

// ChatEvent is one observation about a turn that is still running. Never
// persisted anywhere: it feeds the in-memory chat-progress snapshot + SSE push
// (chat_progress.go / eventbus.go in package main), both of which are lost on
// restart by design.
type ChatEvent struct {
	Kind      ChatEventKind
	Tool      string // ChatEventTool: the tool name, e.g. "Read"
	Detail    string // ChatEventTool: a short, already-truncated argument hint (a path, a pattern)
	TextDelta string // ChatEventText: the newly produced piece of visible answer text
}

// maxEventDetail truncates a tool argument hint — it goes straight into a
// one-line status label, so an enormous Bash command or Edit payload must
// never travel along in full.
const maxEventDetail = 120

// ChatResult is what RunChat returns: the model's final text for this turn,
// plus the session id to pass as RunRequest.SessionID on the next turn (it
// never changes once a session exists — the CLI's own session id is stable
// across --resume calls).
type ChatResult struct {
	Text      string
	SessionID string
}

// Client is the module's behaviour, so workflows and tests can depend on an
// interface and swap in Fake.
type Client interface {
	// Run executes the prompt against the model and returns the model's final
	// text (trimmed). The prompt is passed as a separate arg (never a shell
	// string) and the run is bounded by ctx.
	Run(ctx context.Context, req RunRequest) (string, error)
	// RunChat is like Run but conversational: with req.SessionID empty it starts
	// a fresh multi-turn session, with it set it continues that session (see
	// RunRequest.SessionID). Used by the claude_chat workflow; every existing
	// one-shot caller keeps using Run and is unaffected by this method's
	// existence.
	RunChat(ctx context.Context, req RunRequest) (ChatResult, error)
}

// Module is the production Client: it shells out to the `claude` CLI.
type Module struct {
	// scratchDir is the cwd used for a non-agentic run (RunRequest.WorkDir ==
	// "" — a context-only completion with no tools, e.g. resolve_call's Haiku
	// pass, explain_code, pr_status's summary). It deliberately holds no
	// CLAUDE.md/.claude/ tree, so `claude`'s automatic project-memory
	// discovery finds nothing to load there — see "Context-only Haiku calls
	// run from a neutral scratch cwd" in .claude/docs/tembed-workflows.md.
	// Left "" it falls back to the previous behaviour (inherit the caller's
	// own cwd), which is what tests that don't care about this use.
	// Agentic runs are never affected: a non-empty RunRequest.WorkDir (a
	// checked-out PR worktree) always wins over scratchDir.
	scratchDir string
}

// New returns a production Module. scratchDir is reserved purely as a cwd for
// context-only runs; it is created if missing (best-effort — a failure here
// just means Run falls back to inheriting the caller's cwd, same as passing
// ""). It must never sit inside a directory tree that carries a
// CLAUDE.md/.claude/rules anywhere in its ancestor chain — `claude` walks
// *up* from its cwd looking for one (like git looks for .git), so even an
// otherwise-empty subdirectory of a repo still finds and loads that repo's
// CLAUDE.md. The caller (tasks_api.go) anchors this under os.TempDir(), not
// under this project's own data directory, for exactly that reason.
func New(scratchDir string) *Module {
	if scratchDir != "" {
		_ = os.MkdirAll(scratchDir, 0o755)
	}
	return &Module{scratchDir: scratchDir}
}

// Run invokes `claude -p <prompt> --model <model>` (plus, for agentic runs, a
// working directory and a read-only tool allowlist, and — for any run whose
// caller supplied one — a static --append-system-prompt). Output is captured
// in text mode; the caller's prompt is responsible for constraining it to JSON.
func (m *Module) Run(ctx context.Context, req RunRequest) (string, error) {
	args := []string{"-p", req.Prompt, "--model", req.Model}
	if len(req.Tools) > 0 {
		// Restrict the agentic run to read-only tools and auto-approve them so it
		// stays non-interactive.
		args = append(args, "--allowedTools", strings.Join(req.Tools, ","),
			"--permission-mode", "acceptEdits")
	} else {
		// No tools: a pure context-only completion.
		args = append(args, "--allowedTools", "")
	}
	if req.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", req.SystemPrompt)
	}
	// Agentic (Tools set) legitimately needs much more time than a bare
	// context-only completion — see the contextTimeout/agenticTimeout doc.
	timeout := contextTimeout
	if len(req.Tools) > 0 {
		timeout = agenticTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "claude", args...)
	switch {
	case req.WorkDir != "":
		// Agentic run: the caller needs real file access (Read/Grep/Glob) inside
		// a specific checked-out worktree — keep it, even though that worktree
		// may carry its own CLAUDE.md/.claude/rules (a separate, larger cost
		// driver tracked outside this fix, see tembed-workflows.md).
		cmd.Dir = req.WorkDir
	case m.scratchDir != "":
		// Context-only run: no tools, so no reason to sit inside any repo.
		cmd.Dir = m.scratchDir
	}
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("claude -p (%s): %w", req.Model, err)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// RunChat is Run's conversational sibling: it invokes
// `claude -p <prompt> --model <model> --output-format stream-json --verbose`
// plus either `--session-id <uuid>` (fresh session, req.SessionID == "") or
// `--resume <req.SessionID>` (continue an existing one) — confirmed against
// the real CLI (--session-id must be a valid UUID; --resume with the same id
// keeps prior turns in context; the streamed output's "session_id" stays the
// same id across turns, it never rotates).
//
// stream-json rather than the plain `json` format because the turn is long
// (a real subprocess call, minutes for an agentic edit) and the reviewer must
// be able to SEE it progress: the CLI emits one JSON object per line while it
// works, which readChatStream turns into ChatEvents for req.OnEvent. The
// return value is unchanged either way — the final `{"type":"result",...}`
// line carries exactly the same "result"/"session_id" fields the old
// non-streaming format returned as a single object, so a caller that sets no
// OnEvent sees no behavioural difference at all. --verbose is mandatory for
// stream-json under --print; --include-partial-messages (which is what makes
// the answer arrive token by token instead of one block at a time) is only
// asked for when someone is actually listening.
func (m *Module) RunChat(ctx context.Context, req RunRequest) (ChatResult, error) {
	args := []string{"-p", req.Prompt, "--model", req.Model, "--output-format", "stream-json", "--verbose"}
	if req.OnEvent != nil {
		args = append(args, "--include-partial-messages")
	}
	if len(req.Tools) > 0 {
		args = append(args, "--allowedTools", strings.Join(req.Tools, ","),
			"--permission-mode", "acceptEdits")
	} else {
		args = append(args, "--allowedTools", "")
	}
	if req.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", req.SystemPrompt)
	}
	sessionID := req.SessionID
	if sessionID == "" {
		sessionID = newSessionID()
		args = append(args, "--session-id", sessionID)
	} else {
		args = append(args, "--resume", sessionID)
	}
	timeout := contextTimeout
	if len(req.Tools) > 0 {
		timeout = agenticTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "claude", args...)
	switch {
	case req.WorkDir != "":
		cmd.Dir = req.WorkDir
	case m.scratchDir != "":
		cmd.Dir = m.scratchDir
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ChatResult{}, fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, err)
	}
	if err := cmd.Start(); err != nil {
		return ChatResult{}, fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, err)
	}
	// Read to EOF first, then Wait — a Wait before the pipe is drained would
	// close it out from under the reader.
	res, parseErr := readChatStream(stdout, req.OnEvent)
	if err := cmd.Wait(); err != nil {
		return ChatResult{}, fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, err)
	}
	if parseErr != nil {
		return ChatResult{}, fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, parseErr)
	}
	if res.SessionID == "" {
		// Shouldn't happen (the CLI always echoes session_id), but never drop the
		// session id we ourselves picked/were given.
		res.SessionID = sessionID
	}
	res.Text = strings.TrimSpace(res.Text)
	return res, nil
}

// chatStreamLine is the subset of one stream-json line this module cares
// about. Every unknown type/field is ignored on purpose: the CLI emits a lot
// more (hook lifecycle, token estimates, rate-limit info) and a new frame type
// must never break a turn.
type chatStreamLine struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	Result    string `json:"result"`
	SessionID string `json:"session_id"`
	Event     *struct {
		Type  string `json:"type"`
		Delta *struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
		ContentBlock *struct {
			Type string `json:"type"`
			Name string `json:"name"`
		} `json:"content_block"`
	} `json:"event"`
	Message *struct {
		Content []struct {
			Type  string         `json:"type"`
			Name  string         `json:"name"`
			Input map[string]any `json:"input"`
		} `json:"content"`
	} `json:"message"`
}

// readChatStream consumes the CLI's newline-delimited JSON output, forwarding
// each interesting frame to onEvent (when non-nil) and returning the final
// `result` frame's payload. A line that doesn't parse is skipped rather than
// fatal — only a stream that never produced a result frame is an error.
//
// bufio.Reader, not bufio.Scanner: a single line can be very large (the init
// frame lists every tool, a thinking signature is a long base64 blob, a tool
// result can be a whole file) and Scanner has a hard token limit.
func readChatStream(r io.Reader, onEvent func(ChatEvent)) (ChatResult, error) {
	br := bufio.NewReader(r)
	var res ChatResult
	seenResult := false
	for {
		line, err := br.ReadString('\n')
		if s := strings.TrimSpace(line); s != "" {
			var l chatStreamLine
			if json.Unmarshal([]byte(s), &l) == nil {
				if l.Type == "result" {
					res.Text, res.SessionID, seenResult = l.Result, l.SessionID, true
				} else if onEvent != nil {
					emitChatEvents(l, onEvent)
				}
			}
		}
		if err != nil {
			break
		}
	}
	if !seenResult {
		return ChatResult{}, fmt.Errorf("no result frame in stream output")
	}
	return res, nil
}

// emitChatEvents maps one parsed non-result frame onto zero or more
// ChatEvents. Thinking deltas deliberately forward NO text: what the reviewer
// wants from them is the fact that Claude is thinking, not a transcript of it.
func emitChatEvents(l chatStreamLine, onEvent func(ChatEvent)) {
	switch l.Type {
	case "system":
		if l.Subtype == "init" {
			onEvent(ChatEvent{Kind: ChatEventStatus})
		}
	case "stream_event":
		if l.Event == nil {
			return
		}
		switch l.Event.Type {
		case "content_block_delta":
			if l.Event.Delta == nil {
				return
			}
			switch l.Event.Delta.Type {
			case "text_delta":
				if l.Event.Delta.Text != "" {
					onEvent(ChatEvent{Kind: ChatEventText, TextDelta: l.Event.Delta.Text})
				}
			case "thinking_delta":
				onEvent(ChatEvent{Kind: ChatEventThinking})
			}
		case "content_block_start":
			// The tool name is known here; its arguments only stream in
			// afterwards, so the richer Detail comes from the "assistant" frame
			// below (which repeats the block with its input filled in).
			if l.Event.ContentBlock != nil && l.Event.ContentBlock.Type == "tool_use" {
				onEvent(ChatEvent{Kind: ChatEventTool, Tool: l.Event.ContentBlock.Name})
			}
		}
	case "assistant":
		if l.Message == nil {
			return
		}
		for _, block := range l.Message.Content {
			if block.Type == "tool_use" {
				onEvent(ChatEvent{Kind: ChatEventTool, Tool: block.Name, Detail: toolInputHint(block.Input)})
			}
		}
	}
}

// toolInputHint picks the one argument worth showing next to a tool name, in
// a fixed order so the same tool always reports the same field (never map
// iteration order, which would make the label flicker between runs).
func toolInputHint(input map[string]any) string {
	for _, key := range []string{"file_path", "path", "pattern", "command", "query", "url", "prompt"} {
		if s, ok := input[key].(string); ok && strings.TrimSpace(s) != "" {
			s = strings.TrimSpace(s)
			if len(s) > maxEventDetail {
				s = s[:maxEventDetail] + "…"
			}
			return strings.ReplaceAll(s, "\n", " ")
		}
	}
	return ""
}

// newSessionID returns a random UUID v4, the shape `claude --session-id`
// requires. Called only from a Module method (a side effect anyway — this is
// not workflow-body code, so plain crypto/rand is fine per
// .claude/rules/workflow-determinism.md).
func newSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Fake is an in-memory Client for tests. Outputs are keyed by model id; each
// Run records the request.
type Fake struct {
	mu      sync.Mutex
	outputs map[string]string
	errs    map[string]error
	Calls   []RunRequest
	// chatQueue/chatErr program RunChat: a FIFO of turn outputs consumed one per
	// call, regardless of session — deliberately simpler than per-session
	// queues, since every test using this drives one conversation at a time.
	// chatSeq numbers the fake session ids RunChat hands out for a fresh
	// (SessionID == "") call.
	chatQueue []string
	chatErr   error
	chatSeq   int
	// chatEvents are replayed to req.OnEvent (when set) before each RunChat
	// call returns, so a test can drive the progress/streaming path without a
	// real subprocess. Programmed once and reused for every call — a test that
	// cares about progress drives one turn at a time.
	chatEvents []ChatEvent
}

// NewFake returns an empty Fake.
func NewFake() *Fake { return &Fake{outputs: map[string]string{}, errs: map[string]error{}} }

// SetOutput programs the text Run returns for a given model id.
func (f *Fake) SetOutput(model, out string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.outputs == nil {
		f.outputs = map[string]string{}
	}
	f.outputs[model] = out
}

// SetError programs Run to fail for a given model id.
func (f *Fake) SetError(model string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errs == nil {
		f.errs = map[string]error{}
	}
	f.errs[model] = err
}

// Run returns the programmed output/error for req.Model.
func (f *Fake) Run(ctx context.Context, req RunRequest) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, req)
	if err := f.errs[req.Model]; err != nil {
		return "", err
	}
	return f.outputs[req.Model], nil
}

// CallCount reports how many Run calls were recorded.
func (f *Fake) CallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.Calls)
}

// SetChatTurns programs the sequence of texts RunChat returns, one per call,
// in order (across however many sessions this Fake sees — see the Fake's own
// chatQueue doc comment).
func (f *Fake) SetChatTurns(texts ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chatQueue = append([]string(nil), texts...)
}

// SetChatEvents programs the ChatEvents every RunChat call replays to
// req.OnEvent before returning its text (a no-op when the caller set no
// OnEvent), so a test can exercise the live-progress path offline.
func (f *Fake) SetChatEvents(evs ...ChatEvent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chatEvents = append([]ChatEvent(nil), evs...)
}

// SetChatError makes every RunChat call fail with err until reset (pass nil).
func (f *Fake) SetChatError(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chatErr = err
}

// RunChat returns the next programmed text off chatQueue (or "" once
// exhausted) and a session id: req.SessionID echoed back if set, otherwise a
// fresh deterministic fake id ("fake-session-N") — mirroring the real
// Module's "empty starts a session, non-empty resumes it" contract closely
// enough for a workflow test to assert on. Every call is recorded in Calls,
// like Run.
func (f *Fake) RunChat(ctx context.Context, req RunRequest) (ChatResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, req)
	if req.OnEvent != nil {
		for _, ev := range f.chatEvents {
			req.OnEvent(ev)
		}
	}
	if f.chatErr != nil {
		return ChatResult{}, f.chatErr
	}
	sessionID := req.SessionID
	if sessionID == "" {
		f.chatSeq++
		sessionID = fmt.Sprintf("fake-session-%d", f.chatSeq)
	}
	var text string
	if len(f.chatQueue) > 0 {
		text = f.chatQueue[0]
		f.chatQueue = f.chatQueue[1:]
	}
	return ChatResult{Text: text, SessionID: sessionID}, nil
}
