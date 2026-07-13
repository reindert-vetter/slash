// Package claude is the Claude-CLI bridge module: the one place that shells out
// to the local `claude` CLI (Anthropic's Claude Code) to resolve a PHP method
// call to its definition. It is driven by workflow Activities — per the project
// rule, only workflows mutate state, and a module like this runs on their
// behalf (it performs a side effect: running a subprocess).
//
// It is deliberately domain-thin: it runs a prompt against a model and returns
// the model's final text. Parsing that text into a resolution is the caller's
// job (the resolve_call workflow). This keeps the bridge reusable and testable
// via the Fake, which callers swap in under SLASH_CLAUDE=off so tests never hit
// the network.
package claude

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

// Full model IDs (see the claude-api reference).
const (
	ModelHaiku  = "claude-haiku-4-5"
	ModelSonnet = "claude-sonnet-5"
)

// RunRequest is a single non-interactive `claude -p` invocation.
type RunRequest struct {
	Model   string   // full model id (ModelHaiku / ModelSonnet)
	Prompt  string   // the user prompt; the caller instructs the model to answer as JSON
	WorkDir string   // cwd for agentic runs (a checked-out worktree); "" inherits
	Tools   []string // allowed read-only tools for agentic runs (e.g. Read, Grep, Glob); empty = no tools
}

// Client is the module's behaviour, so workflows and tests can depend on an
// interface and swap in Fake.
type Client interface {
	// Run executes the prompt against the model and returns the model's final
	// text (trimmed). The prompt is passed as a separate arg (never a shell
	// string) and the run is bounded by ctx.
	Run(ctx context.Context, req RunRequest) (string, error)
}

// Module is the production Client: it shells out to the `claude` CLI.
type Module struct{}

// New returns a production Module.
func New() *Module { return &Module{} }

// Run invokes `claude -p <prompt> --model <model>` (plus, for agentic runs, a
// working directory and a read-only tool allowlist). Output is captured in text
// mode; the caller's prompt is responsible for constraining it to JSON.
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
	cmd := exec.CommandContext(ctx, "claude", args...)
	if req.WorkDir != "" {
		cmd.Dir = req.WorkDir
	}
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("claude -p (%s): %w", req.Model, err)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// Fake is an in-memory Client for tests. Outputs are keyed by model id; each
// Run records the request.
type Fake struct {
	mu      sync.Mutex
	outputs map[string]string
	errs    map[string]error
	Calls   []RunRequest
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
