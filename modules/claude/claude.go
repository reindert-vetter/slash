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
	"syscall"
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
	// Steer, when non-nil, lets the caller hand EXTRA reviewer messages to a
	// turn that is ALREADY running (RunChat only; Run ignores it). Every text
	// received on it is written to the CLI's stdin as one more stream-json
	// user frame, which the CLI picks up at the running turn's next step
	// boundary — see "Steering a running turn" below. Nil keeps the historical
	// argv-prompt invocation byte for byte, so a caller that never steers
	// (comment_batch, test_run) is unaffected.
	//
	// Like OnEvent it is deliberately a Go channel rather than data, so it is
	// structurally impossible for it to end up in a workflow Activity's
	// recorded input. Unlike OnEvent it is NOT purely observational: a steered
	// message really does change what this turn answers. That is why the
	// durable record of such a message is written by the chat_steer workflow
	// that produced it, never inferred from the turn's own result — see
	// chat_steer.go and .claude/docs/claude-chat-panel.md.
	Steer <-chan string
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
	// ChatEventTurn fires once per model "assistant" frame — i.e. once per
	// agentic step, matching the CLI's own final `num_turns` count. A step
	// that also invokes a tool fires both this and ChatEventTool; a step that
	// only produces text (e.g. the final JSON answer) fires only this one.
	// Added for code_warning's turn budget (see runCodeWarningReview,
	// package main) — every existing switch over ChatEventKind has no
	// default case, so this new kind is silently ignored by every consumer
	// that doesn't opt in.
	ChatEventTurn ChatEventKind = "turn"
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
	// IsError mirrors the CLI's own `"is_error"` field on the final `result`
	// stream frame: the turn ran to completion but the CLI itself judged it a
	// failure (e.g. an API-level error such as an invalid model, a billing
	// problem, or a usage limit — see the CLI's own `result` text for which).
	// A ChatResult with IsError set is never returned as a "success" by
	// RunChat — see ChatCallError.
	IsError bool
	// Usage mirrors the CLI's own final `result` frame cost/token accounting
	// (its "num_turns"/"total_cost_usd"/"usage" fields) — zero-valued when
	// the stream never carried them (e.g. Fake). Added for code_warning's
	// turn-budget measurement (see the "onbeperkt"/8/5-turn comparison in
	// .claude/docs/workflows-analysis.md); every existing caller ignores it,
	// same additive shape as ChatEventTurn.
	Usage ChatUsage
}

// ChatUsage is the cost/token accounting the CLI itself reports on a turn's
// final `result` frame. CacheReadInputTokens/CacheCreationInputTokens are
// broken out separately from InputTokens because they are typically the bulk
// of an agentic run's cost (the resent, cached prefix — see
// codeWarningDefaultMaxTurns' own doc comment in package main).
type ChatUsage struct {
	NumTurns                 int
	TotalCostUSD             float64
	InputTokens              int
	OutputTokens             int
	CacheReadInputTokens     int
	CacheCreationInputTokens int
}

// ChatCallError wraps a RunChat failure with, where available, the CLI's OWN
// human-readable explanation — never a message this module invents.
//
// Verified directly (manual `claude -p --output-format stream-json --verbose`
// run with a deliberately invalid --model): the CLI still completes its
// stream and prints a final `result` frame with `"is_error":true` and a
// `result` string spelling out exactly what went wrong ("There's an issue
// with the selected model…"), while the process itself exits non-zero.
// Before this type existed, RunChat treated any non-zero exit as fatal and
// discarded that already-parsed, informative text — the caller only ever
// saw a bare "exit status 1", which is why a Claude call failure always
// rendered as the same generic "Er ging iets mis" wording (chatFailureTurn,
// chat_workflow.go) no matter the real cause.
//
// Definitive is true only when Reason came from that `is_error` verdict — a
// completed CLI turn that judged ITSELF a failure, as opposed to a bare
// process/exec problem (pipe broken, binary missing, our own context
// timeout). That distinction matters for whether an automatic retry is even
// worth suggesting: a CLI-level verdict (e.g. a usage limit, which normally
// resets hours later, not seconds) is very unlikely to change on an
// immediate retry, unlike a plain exec hiccup.
type ChatCallError struct {
	Reason     string // human-readable, from the CLI itself; "" if truly unknown
	Definitive bool
	Err        error // the underlying process/parse error, always non-nil
}

func (e *ChatCallError) Error() string {
	if e.Reason != "" {
		return e.Reason
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	return "claude chat call failed"
}

func (e *ChatCallError) Unwrap() error { return e.Err }

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

// killOwnProcessGroup makes cmd (not yet started) the leader of a fresh
// process group and, on a context cancellation/timeout, kills that WHOLE
// group instead of exec.CommandContext's default of only killing cmd.Process
// itself.
//
// This matters specifically for an agentic run (req.Tools includes "Bash"):
// the claude CLI's own Bash tool calls spawn real child processes (a shell,
// and whatever that shell runs), which are direct children of `claude`, not
// of this Go process — killing only `claude` leaves them as orphans that
// keep running after the reviewer's own "Stop" (see chat_cancel.go) already
// told the UI the turn is "afgebroken". Setpgid makes `claude` its own group
// leader (pgid == its own pid), so `kill(-pgid, …)` reaches every descendant
// it spawned, however deep. POSIX-only (Setpgid/negative-pid kill), matching
// every other assumption already baked into this codebase (see CLAUDE.md);
// not attempted on a platform where that would fail to build.
func killOwnProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// Run invokes `claude -p <prompt> --model <model>` (plus, for agentic runs, a
// working directory and a read-only tool allowlist, and — for any run whose
// caller supplied one — a static --append-system-prompt). Output is captured
// in text mode; the caller's prompt is responsible for constraining it to JSON.
func (m *Module) Run(ctx context.Context, req RunRequest) (string, error) {
	args := []string{"-p", req.Prompt, "--model", req.Model}
	args = append(args, coldStartArgs()...)
	if len(req.Tools) > 0 {
		// Restrict the agentic run to read-only tools and auto-approve them so it
		// stays non-interactive. --tools additionally shrinks the CLI's own
		// built-in tool UNIVERSE (as opposed to --allowedTools, which only gates
		// permission within the existing universe) — see agenticToolUniverse.
		args = append(args, "--allowedTools", strings.Join(req.Tools, ","),
			"--permission-mode", "acceptEdits",
			"--tools", strings.Join(agenticToolUniverse(req.Tools), ","))
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
	killOwnProcessGroup(cmd)
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
	args := []string{"-p"}
	// Steering needs the prompt to travel over stdin (the CLI reads no further
	// input at all when the prompt sits in argv), so the whole turn switches to
	// --input-format stream-json. Without a Steer channel nothing changes: the
	// prompt stays an argv arg, stdin stays unconnected.
	if req.Steer == nil {
		args = append(args, req.Prompt)
	}
	args = append(args, "--model", req.Model, "--output-format", "stream-json", "--verbose")
	if req.Steer != nil {
		args = append(args, "--input-format", "stream-json")
	}
	args = append(args, coldStartArgs()...)
	if req.OnEvent != nil {
		args = append(args, "--include-partial-messages")
	}
	if len(req.Tools) > 0 {
		args = append(args, "--allowedTools", strings.Join(req.Tools, ","),
			"--permission-mode", "acceptEdits",
			"--tools", strings.Join(agenticToolUniverse(req.Tools), ","))
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
	killOwnProcessGroup(cmd)
	switch {
	case req.WorkDir != "":
		cmd.Dir = req.WorkDir
	case m.scratchDir != "":
		cmd.Dir = m.scratchDir
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ChatResult{}, &ChatCallError{Err: fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, err)}
	}
	var stdin io.WriteCloser
	if req.Steer != nil {
		if stdin, err = cmd.StdinPipe(); err != nil {
			return ChatResult{}, &ChatCallError{Err: fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, err)}
		}
	}
	// Captured (not discarded) so a failure can carry the CLI's own diagnostic
	// text when the stream itself never produced a usable `result` frame — see
	// ChatCallError.
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf
	if err := cmd.Start(); err != nil {
		return ChatResult{}, &ChatCallError{Err: fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, err)}
	}
	// Steering: the prompt itself is the first stdin frame, and every later
	// steer message is one more. stdin MUST be closed again once the turn
	// produced its result — with it open the CLI keeps waiting for more input
	// and never exits, so stdout would never reach EOF and cmd.Wait would
	// block forever. closeStdin is therefore called from readChatStream's own
	// result callback (and once more, harmlessly, on the way out).
	var closeStdinOnce sync.Once
	closeStdin := func() {
		if stdin == nil {
			return
		}
		closeStdinOnce.Do(func() { _ = stdin.Close() })
	}
	defer closeStdin()
	if req.Steer != nil {
		if err := writeUserFrame(stdin, req.Prompt); err != nil {
			closeStdin()
			_ = cmd.Wait()
			return ChatResult{}, &ChatCallError{Err: fmt.Errorf("claude -p --input-format stream-json (%s): %w", req.Model, err)}
		}
		// One writer goroutine for the whole turn; it ends with the turn (ctx
		// cancel, or the closed stdin making the write fail) and never outlives
		// this call in a way that could reach a LATER turn — the channel itself
		// belongs to this turn's caller.
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case text, ok := <-req.Steer:
					if !ok {
						return
					}
					if err := writeUserFrame(stdin, text); err != nil {
						return
					}
				}
			}
		}()
	}
	// Read to EOF first, then Wait — a Wait before the pipe is drained would
	// close it out from under the reader.
	res, parseErr := readChatStream(stdout, req.OnEvent, closeStdin)
	waitErr := cmd.Wait()

	// The CLI ran to completion and told us, in its own words, that the turn
	// failed (is_error on the result frame) — its own verdict, checked BEFORE
	// waitErr, since this can be true even on a zero exit. Never let this
	// text be silently thrown away in favor of a bare "exit status N" (see
	// ChatCallError's doc comment for the verified repro).
	if parseErr == nil && res.IsError {
		return ChatResult{}, &ChatCallError{Reason: res.Text, Definitive: true, Err: waitErr}
	}
	if waitErr != nil {
		return ChatResult{}, &ChatCallError{
			Reason: lastNonEmptyLine(stderrBuf.String()),
			Err:    fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, waitErr),
		}
	}
	if parseErr != nil {
		return ChatResult{}, &ChatCallError{
			Reason: lastNonEmptyLine(stderrBuf.String()),
			Err:    fmt.Errorf("claude -p --output-format stream-json (%s): %w", req.Model, parseErr),
		}
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
	Type         string  `json:"type"`
	Subtype      string  `json:"subtype"`
	Result       string  `json:"result"`
	IsError      bool    `json:"is_error"`
	SessionID    string  `json:"session_id"`
	NumTurns     int     `json:"num_turns"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	Usage        *struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	} `json:"usage"`
	Event *struct {
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

// writeUserFrame writes one stream-json user message to the CLI's stdin — the
// only input shape --input-format stream-json accepts. Used for the prompt
// itself and for every steer message (see RunRequest.Steer).
func writeUserFrame(w io.Writer, text string) error {
	frame := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": text}},
		},
	}
	b, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

// readChatStream consumes the CLI's newline-delimited JSON output, forwarding
// each interesting frame to onEvent (when non-nil) and returning the final
// `result` frame's payload. A line that doesn't parse is skipped rather than
// fatal — only a stream that never produced a result frame is an error.
//
// onResult (when non-nil) fires once, on the FIRST result frame — RunChat uses
// it to close the CLI's stdin, which is what lets a steered (stream-json input)
// run terminate at all.
//
// A steered run can produce a SECOND result frame: a steer message that
// arrived too late for the running turn's last step boundary is executed by
// the CLI as its own follow-up turn (it still does so after stdin closed).
// Rather than let that overwrite the first answer — or drop it — the texts are
// joined, so the reviewer sees both halves in the one bubble this turn owns.
//
// bufio.Reader, not bufio.Scanner: a single line can be very large (the init
// frame lists every tool, a thinking signature is a long base64 blob, a tool
// result can be a whole file) and Scanner has a hard token limit.
func readChatStream(r io.Reader, onEvent func(ChatEvent), onResult func()) (ChatResult, error) {
	br := bufio.NewReader(r)
	var res ChatResult
	seenResult := false
	for {
		line, err := br.ReadString('\n')
		if s := strings.TrimSpace(line); s != "" {
			var l chatStreamLine
			if json.Unmarshal([]byte(s), &l) == nil {
				if l.Type == "result" {
					if seenResult {
						res.Text = strings.TrimSpace(res.Text + "\n\n" + l.Result)
					} else {
						res.Text = l.Result
						if onResult != nil {
							onResult()
						}
					}
					res.SessionID, res.IsError, seenResult = l.SessionID, res.IsError || l.IsError, true
					// Overwritten on a second result frame (a late steer
					// message executed as its own follow-up turn, see
					// above) — the CLI reports cumulative usage for the
					// whole turn so far, so the latest frame's numbers are
					// the ones that matter.
					res.Usage.NumTurns, res.Usage.TotalCostUSD = l.NumTurns, l.TotalCostUSD
					if l.Usage != nil {
						res.Usage.InputTokens = l.Usage.InputTokens
						res.Usage.OutputTokens = l.Usage.OutputTokens
						res.Usage.CacheReadInputTokens = l.Usage.CacheReadInputTokens
						res.Usage.CacheCreationInputTokens = l.Usage.CacheCreationInputTokens
					}
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

// lastNonEmptyLine returns the last non-blank line of s, trimmed — used to
// pull one readable diagnostic line out of the CLI's captured stderr when the
// stream itself never produced a `result` frame to explain the failure with.
// "" when s has no non-blank line at all.
func lastNonEmptyLine(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
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
		onEvent(ChatEvent{Kind: ChatEventTurn})
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

// coldStartArgs are two CLI flags applied to EVERY invocation (agentic or
// context-only), aimed at the ~45k cache_creation_input_tokens a brand-new
// claude_chat conversation pays before its first token (see
// .claude/docs/workflows-comments.md, "Cold-start cost of a brand-new
// conversation"):
//
//   - --strict-mcp-config: this module never passes --mcp-config, so this
//     simply makes sure NO MCP server configured anywhere on the machine
//     (project or personal, e.g. a personal Atlassian/Jira MCP server) is
//     loaded into a review-chat turn. Review-chat never needs an MCP tool, so
//     this can only remove content, never behaviour.
//   - --exclude-dynamic-system-prompt-sections: moves the per-machine parts of
//     the DEFAULT system prompt (cwd, env info, git status) out of the cached
//     prefix and into the first user message. Every claude_chat conversation
//     gets its OWN shadow worktree directory (chat_shadow.go), so without this
//     flag the cwd path is baked into the cached prefix and no two
//     conversations can ever share a prompt cache entry, however identical
//     their tool/system-prompt setup otherwise is. Measured directly (manual
//     `claude -p` runs against copies of a real shadow worktree, haiku model):
//     repeating the SAME flag combination from DIFFERENT scratch directories
//     showed the second+ run reading back the bulk of the first run's prefix
//     via cache_read instead of paying it again as cache_creation — something
//     that structurally cannot happen at all without this flag, since today
//     every conversation's cwd is unique.
//
// Deliberately NOT included here: any setting-sources/plugin restriction
// (Reindert: the risk of breaking plug-and-pay's project-level
// claude-security plugin isn't worth the win) and any skills-disabling flag
// (Reindert: skills stay on unconditionally, even accounting for their token
// cost — see the exact "Skill" handling in agenticToolUniverse below).
func coldStartArgs() []string {
	return []string{"--strict-mcp-config", "--exclude-dynamic-system-prompt-sections"}
}

// agenticToolUniverse is what an agentic run passes to --tools: req.Tools
// (the caller's read-only-plus-Edit/Bash allowlist) PLUS "Skill". --tools
// shrinks the CLI's own built-in tool UNIVERSE, unlike --allowedTools, which
// only gates permission within whatever universe already exists — so leaving
// a tool out here removes it, and everything it advertises, entirely; a tool
// left IN stays available but not auto-approved unless it's also in
// req.Tools/--allowedTools (same as today, before --tools existed here).
//
// Verified directly (manual `claude -p --output-format stream-json --verbose`
// runs against a copy of a real chat shadow worktree, so numbers are
// measured, not estimated): restricting the universe to
// "Read,Grep,Glob,Edit,Bash" (no Skill) cut the steady-state cache_creation +
// cache_read total roughly in half versus the CLI's default (unrestricted)
// universe — from ~31.2k to ~15.6k tokens — because the CLI no longer has to
// describe the ~25 tools req.Tools structurally can never reach anyway: Task
// (no subagent can ever run — req.Tools never includes Task, so every
// subagent this call is told about, including plug-and-pay's own
// project-configured ones, is unreachable dead weight), the background-agent
// family (CronCreate/CronList/DesignSync/PushNotification/RemoteTrigger/
// SendMessage/TaskCreate/…), NotebookEdit, Monitor, Write, and the MCP
// resource tools (already moot given --strict-mcp-config above).
//
// "Skill" is added back explicitly — NOT because pruning it failed to save
// tokens (it does: ~2.6k tokens in the same measurement) but because
// Reindert decided skills stay on unconditionally, and dropping "Skill" from
// the universe removes the ONLY tool the model would need to actually invoke
// one autonomously (confirmed: omitting it from --tools removes "Skill" from
// the CLI's own reported tool universe entirely). It is deliberately not
// added to req.Tools/--allowedTools itself — that mirrors exactly how skills
// already work today (available in the default, unrestricted universe,
// without being explicitly allow-listed), so this change doesn't alter
// skill-permission behaviour, only removes what was never reachable.
func agenticToolUniverse(tools []string) []string {
	universe := append([]string{}, tools...)
	return append(universe, "Skill")
}

// Fake is an in-memory Client for tests. Outputs are keyed by model id; each
// Run records the request.
type Fake struct {
	mu      sync.Mutex
	outputs map[string]string
	// promptOutputs additionally keys on req.SystemPrompt (model+"\n"+prompt),
	// checked in Run BEFORE the plain model-only outputs map — several
	// context-only Haiku actions (pr_summary, since_review, chat_summary) share
	// ModelHaiku but must be programmable independently in the same test run;
	// each carries its own static SystemPrompt already, so that's a free,
	// already-unique disambiguator. See SetOutputForPrompt.
	promptOutputs map[string]string
	errs          map[string]error
	Calls         []RunRequest
	// chatQueue/chatErr program RunChat. chatQueue is the programmed turn
	// script and is NEVER consumed: chatPos holds a cursor PER SESSION into it,
	// so a fresh session (SessionID == "") starts over at turn 0 while a
	// resumed session walks on to its next turn. It used to be one FIFO shared
	// by every session, which broke as soon as two conversations ran against
	// the same Fake — the Playwright worker server is shared by every chat
	// spec, so whichever spec came second got turn 2 or 3 instead of turn 1.
	// chatSeq numbers the fake session ids RunChat hands out for a fresh
	// (SessionID == "") call.
	chatQueue []string
	chatPos   map[string]int
	// steered records every RunRequest.Steer message a blocked RunChat call
	// received — see Steered.
	steered []string
	chatErr error
	chatSeq int
	// chatModelErrs fails RunChat only for the given model ids, and
	// chatFailures fails the next N calls whatever the model — the two shapes a
	// retry/escalation test needs: "this model is unreachable" and "it was down
	// for a moment". Both are checked before the ordinary chatQueue script.
	chatModelErrs map[string]error
	chatFailures  int
	chatFailErr   error
	// chatEvents are replayed to req.OnEvent (when set) before each RunChat
	// call returns, so a test can drive the progress/streaming path without a
	// real subprocess. Programmed once and reused for every call — a test that
	// cares about progress drives one turn at a time.
	chatEvents []ChatEvent
	// chatBlockUntilCancel makes every RunChat call hang on <-ctx.Done() and
	// return ctx.Err() instead of consulting chatQueue — the fixture a cancel
	// test needs (SLASH_CLAUDE_CHAT_TURNS has no way to make a scripted turn
	// hang until cancelled). See SetChatBlockUntilCancel.
	chatBlockUntilCancel bool
	// chatHook, when set, runs on every RunChat call with that call's own
	// request, before it returns. The only way a test can make a scripted
	// "turn" really touch its WorkDir — a Fake never edits anything by
	// itself — e.g. to simulate Claude's own Edit/Bash tool calls in the
	// checkout. Called without the Fake's own lock held, so the hook may use
	// the Fake again.
	chatHook func(RunRequest)
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

// SetOutputForPrompt programs the text Run returns for a given model id AND
// system prompt — for a context-only action that shares a model with another
// one (see promptOutputs' own doc comment above).
func (f *Fake) SetOutputForPrompt(model, systemPrompt, out string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.promptOutputs == nil {
		f.promptOutputs = map[string]string{}
	}
	f.promptOutputs[model+"\n"+systemPrompt] = out
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
	if out, ok := f.promptOutputs[req.Model+"\n"+req.SystemPrompt]; ok {
		return out, nil
	}
	return f.outputs[req.Model], nil
}

// CallCount reports how many Run calls were recorded.
func (f *Fake) CallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.Calls)
}

// SetChatTurns programs the sequence of texts RunChat returns for a single
// conversation, one per turn, in order. Every session walks this same script
// independently — see the Fake's own chatQueue/chatPos doc comment — so it is
// a per-session turn script, not a global queue. Resets every cursor.
func (f *Fake) SetChatTurns(texts ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chatQueue = append([]string(nil), texts...)
	f.chatPos = map[string]int{}
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

// SetChatModelError makes every RunChat call for one model id fail with err
// (pass nil to reset it). Lets a test model "this model is unreachable while
// that one answers" — what an Opus→Sonnet escalation needs.
func (f *Fake) SetChatModelError(model string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.chatModelErrs == nil {
		f.chatModelErrs = map[string]error{}
	}
	if err == nil {
		delete(f.chatModelErrs, model)
		return
	}
	f.chatModelErrs[model] = err
}

// SetChatHook programs a callback that runs on every RunChat call with that
// call's own request — see chatHook's own doc comment.
func (f *Fake) SetChatHook(hook func(RunRequest)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chatHook = hook
}

// SetChatBlockUntilCancel(true) makes every subsequent RunChat call hang
// until its own ctx is cancelled (returning ctx.Err()), instead of returning
// the programmed script — a fixture for testing the reviewer-triggered "Stop"
// (chat_cancel.go): a real Claude turn can be interrupted mid-flight, but
// nothing in the ordinary chatQueue script can simulate "still running".
// SetChatBlockUntilCancel(false) reverts to the ordinary script again — e.g.
// for asserting a manual "Opnieuw proberen" after a cancel actually answers.
func (f *Fake) SetChatBlockUntilCancel(block bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chatBlockUntilCancel = block
}

// Steered returns every steer message (RunRequest.Steer) a blocked RunChat
// call received so far — the Fake's counterpart of the real CLI's stdin, see
// SetChatBlockUntilCancel.
func (f *Fake) Steered() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.steered...)
}

// SetChatFailures makes the next n RunChat calls fail with err, after which
// the ordinary programmed script takes over again — a transient outage.
func (f *Fake) SetChatFailures(n int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chatFailures = n
	f.chatFailErr = err
}

// RunChat returns this session's next programmed text off chatQueue (or ""
// once that session ran past the end of the script) and a session id:
// req.SessionID echoed back if set, otherwise a
// fresh deterministic fake id ("fake-session-N") — mirroring the real
// Module's "empty starts a session, non-empty resumes it" contract closely
// enough for a workflow test to assert on. Every call is recorded in Calls,
// like Run.
func (f *Fake) RunChat(ctx context.Context, req RunRequest) (ChatResult, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, req)
	if req.OnEvent != nil {
		for _, ev := range f.chatEvents {
			req.OnEvent(ev)
		}
	}
	block := f.chatBlockUntilCancel
	hook := f.chatHook
	f.mu.Unlock()
	if hook != nil {
		hook(req)
	}
	// SetChatBlockUntilCancel's own test hook: block here, past the mutex, so
	// every other Fake call (progress polling, a second conversation's own
	// RunChat, CallCount) keeps working normally while this one turn sits
	// "running" until the test's own ctx is cancelled — exactly what a cancel
	// test needs, without a real subprocess.
	if block {
		// Steer messages are recorded while blocked, so a test can assert that a
		// steer really reached the RUNNING turn (see Steered) — the fake's
		// stand-in for the real CLI's stdin.
		for {
			select {
			case <-ctx.Done():
				return ChatResult{}, ctx.Err()
			case text, ok := <-req.Steer:
				if !ok {
					req.Steer = nil
					continue
				}
				f.mu.Lock()
				f.steered = append(f.steered, text)
				f.mu.Unlock()
			}
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.chatErr != nil {
		return ChatResult{}, f.chatErr
	}
	if err := f.chatModelErrs[req.Model]; err != nil {
		return ChatResult{}, err
	}
	if f.chatFailures > 0 {
		f.chatFailures--
		return ChatResult{}, f.chatFailErr
	}
	sessionID := req.SessionID
	if sessionID == "" {
		f.chatSeq++
		sessionID = fmt.Sprintf("fake-session-%d", f.chatSeq)
	}
	if f.chatPos == nil {
		f.chatPos = map[string]int{}
	}
	var text string
	if len(f.chatQueue) == 0 {
		// No turn script programmed (SetChatTurns never called): fall back
		// to the same static per-model/per-prompt outputs Run uses, so a
		// caller that switched from Run to RunChat (e.g. code_warning's
		// turn-budget steering) doesn't force every existing SetOutput-based
		// test to also learn SetChatTurns — same priority Run itself uses,
		// promptOutputs before the plain model-keyed map.
		if out, ok := f.promptOutputs[req.Model+"\n"+req.SystemPrompt]; ok {
			text = out
		} else {
			text = f.outputs[req.Model]
		}
	} else if i := f.chatPos[sessionID]; i < len(f.chatQueue) {
		text = f.chatQueue[i]
	}
	f.chatPos[sessionID]++
	return ChatResult{Text: text, SessionID: sessionID}, nil
}
