// qa_run.go — "laat deze PR testen in de admin": ONE agentic Claude run that
// tests a PR by hand in the locally running Plug&Pay stack (a real browser via
// Playwright MCP, laravel-boost, artisan/Nova/DB tricks like a human tester)
// and answers with one JSON QA report — steps with explanation and
// screenshots — that the /qa/<pr> page (src/qa.mjs) renders as columns. See
// .claude/docs/qa-page.md.
//
// Modelled on test_run.go (read its header first); the differences:
//
//  1. MCP servers. The only Claude call in slash that loads MCP servers
//     (claude.RunRequest.MCPConfig): Playwright for the browser and
//     laravel-boost for URLs/logs/read-only queries. Reviewer-approved
//     exception, documented in .claude/docs/qa-page.md.
//  2. The werkmap choice WAITS instead of failing. test_run gives up when the
//     PR's checkout choice is open; a QA run releases the write slot (the
//     answer's own Activity needs it), waits until the reviewer answered it in
//     the werkmap overlay the /qa page mounts, and then resolves the checkout
//     again — "anders vragen", same question mechanism as a chat turn.
//  3. A durable result. The report IS the run's recorded workflow result, so
//     GET /api/qa reads it straight from the tembed store (no module, no
//     read-model); every run is one "round" on the page. Screenshots are files
//     under data/qa/<pr>/<runID>/, written by the Playwright MCP inside the
//     Activity and removed with the PR by purgePR.
//  4. One workflow body, one Activity, no branching — trivially deterministic
//     (.claude/rules/workflow-determinism.md). The round number and the
//     previous round's run id come from the INPUT (computed by the handler),
//     never from a read inside the workflow body.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"

	"slash/modules/claude"
	"slash/modules/langpref"
)

// QARunInput is POST /api/workflows/qa_run's body plus what the handler adds
// (Round, PrevRunID) so the workflow input alone determines everything.
type QARunInput struct {
	Repo         string `json:"repo,omitempty"`
	PR           int    `json:"pr"`
	Instructions string `json:"instructions,omitempty"`
	Round        int    `json:"round"`
	PrevRunID    string `json:"prevRunId,omitempty"`
}

type qaRunArg struct {
	QARunInput
	RunID string `json:"runId"`
}

// qaReport is the JSON shape modules/claude/prompts/qa_run.md fixes. Every
// field is model-authored text, bounded by sanitizeQAReport before it is
// recorded.
type qaReport struct {
	Title      string       `json:"title"`
	Kicker     string       `json:"kicker,omitempty"`
	HeadSHA    string       `json:"headSha,omitempty"`
	Summary    string       `json:"summary,omitempty"`
	Deviations []string     `json:"deviations"`
	Scenarios  []qaScenario `json:"scenarios"`
	Groups     []qaGroup    `json:"groups"`
	Steps      []qaStep     `json:"steps"`
}

type qaScenario struct {
	Name   string `json:"name"`
	Result string `json:"result,omitempty"`
	Status string `json:"status"`
}

type qaGroup struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type qaStep struct {
	Group   string     `json:"group,omitempty"`
	Status  string     `json:"status"`
	Eyebrow string     `json:"eyebrow,omitempty"`
	Title   string     `json:"title"`
	Body    string     `json:"body,omitempty"`
	Images  []qaImage  `json:"images"`
	Pre     string     `json:"pre,omitempty"`
	Table   [][]string `json:"table,omitempty"`
}

type qaImage struct {
	File    string `json:"file"`
	Caption string `json:"caption,omitempty"`
}

// qaRunResult is the run's recorded result: the report, or the reason there is
// none.
type qaRunResult struct {
	Round     int       `json:"round"`
	Report    *qaReport `json:"report,omitempty"`
	Error     string    `json:"error,omitempty"`
	Cancelled bool      `json:"cancelled,omitempty"`
	Dir       string    `json:"dir,omitempty"` // the checkout the run tested in
}

func qaRunCancelID(pr int) string { return fmt.Sprintf("qarun-%d", pr) }

// qaRunDir is where one run's screenshots (and its MCP output) live. Always
// absolute: the server's default data dir is the relative "data", but Claude
// and the Playwright MCP run with the PR checkout as cwd, so a relative path
// would land the screenshots inside that checkout (and the sanitizer, looking
// here, would drop every one of them) — measured on PR 14116, round 1.
func qaRunDir(dataDir string, pr int, runID string) string {
	dir := filepath.Join(dataDir, "qa", fmt.Sprint(pr), runID)
	if abs, err := filepath.Abs(dir); err == nil {
		return abs
	}
	return dir
}

// qaRunIDRe / qaImageFileRe validate the two path segments GET /api/qa/image
// joins onto the data dir — never trusted (.claude/rules/conventions.md).
var (
	qaRunIDRe     = regexp.MustCompile(`^[0-9a-f]{24}$`)
	qaImageFileRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpe?g)$`)
)

func qaRunWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in QARunInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if in.PR <= 0 {
		return json.Marshal(qaRunResult{})
	}
	var res qaRunResult
	if err := w.ExecuteActivity("runQARun", qaRunArg{QARunInput: in, RunID: w.RunID()}, &res); err != nil {
		return nil, fmt.Errorf("run qa run: %w", err)
	}
	return json.Marshal(res)
}

// StartQARun launches a qa_run Execution (deferred to the background, like
// StartTestRun).
func (m *TaskManager) StartQARun(in QARunInput) (string, error) {
	if m.engine == nil {
		return "", fmt.Errorf("no engine")
	}
	return m.engine.StartWorkflowDeferLow(WorkflowQARun, in)
}

// qaChoiceWait bounds how long a run waits for the reviewer to answer an open
// werkmap choice (see the file header, point 2). A var for tests.
var (
	qaChoiceWait     = 30 * time.Minute
	qaChoicePollStep = 2 * time.Second
)

// runQARun is the runQARun Activity's body. Never returns an error — a
// failure becomes qaRunResult.Error (recorded, shown on the page).
func runQARun(ctx context.Context, tm *TaskManager, cl claude.Client, dataDir string, arg qaRunArg) qaRunResult {
	res := qaRunResult{Round: arg.Round}
	if cl == nil {
		res.Error = "Claude is niet beschikbaar."
		return res
	}
	startQARunProgress(arg.Repo, arg.PR, arg.RunID)
	defer finishQARunProgress(arg.Repo, arg.PR)
	fail := func(reason string) qaRunResult {
		res.Error = reason
		mutateQARunProgress(arg.Repo, arg.PR, func(p *qaRunProgress) { p.Error = reason })
		return res
	}
	cancelled := func() qaRunResult {
		res.Cancelled = true
		mutateQARunProgress(arg.Repo, arg.PR, func(p *qaRunProgress) { p.Cancelled = true })
		return res
	}

	runCtx, cancel := context.WithCancel(ctx)
	unregister := registerChatCancel(qaRunCancelID(arg.PR), cancel)
	defer unregister()
	defer cancel()

	setPhase := func(phase string) {
		mutateQARunProgress(arg.Repo, arg.PR, func(p *qaRunProgress) { p.Phase = phase })
	}
	writeSlotKey := checkoutWriteSlotKey(dataDir, arg.Repo, arg.PR)
	var (
		dir     string
		release func()
	)
	waitedFor := time.Duration(0)
	for {
		release = acquireCheckoutWriteSlot(runCtx, dataDir, arg.Repo, arg.PR, "qa run", func() { setPhase(chatPhaseWaiting) })
		if runCtx.Err() != nil {
			release()
			return cancelled()
		}
		setPhase(chatPhasePreparing)
		d, decision, ok := prepareChatShellWorkDir(runCtx, tm, dataDir, arg.Repo, arg.PR, "")
		if runCtx.Err() != nil {
			release()
			return cancelled()
		}
		open := decision != nil || checkoutChoiceOpen(dataDir, arg.Repo, arg.PR)
		if ok && !open {
			dir = d
			break
		}
		// The answer's own Activity takes this same slot, so hand it back
		// while waiting — see the file header, point 2.
		release()
		if !open {
			return fail("Kon geen lokale werkmap voor deze PR klaarzetten (staat de PR-branch ergens uitgecheckt?).")
		}
		mutateQARunProgress(arg.Repo, arg.PR, func(p *qaRunProgress) { p.WaitingChoice = true; p.Phase = chatPhaseWaiting })
		for checkoutChoiceOpen(dataDir, arg.Repo, arg.PR) {
			if waitedFor >= qaChoiceWait {
				return fail("Er stond te lang een werkmap-keuze open. Maak die keuze en start de QA-test opnieuw.")
			}
			select {
			case <-runCtx.Done():
				return cancelled()
			case <-time.After(qaChoicePollStep):
			}
			waitedFor += qaChoicePollStep
		}
		mutateQARunProgress(arg.Repo, arg.PR, func(p *qaRunProgress) { p.WaitingChoice = false })
	}
	defer release()
	res.Dir = dir

	runDir := qaRunDir(dataDir, arg.PR, arg.RunID)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return fail("Kon de screenshotmap niet aanmaken.")
	}
	var prev *qaReport
	if arg.PrevRunID != "" && tm != nil && tm.engine != nil {
		var pr qaRunResult
		if tm.engine.Result(arg.PrevRunID, &pr) == nil {
			prev = pr.Report
		}
	}

	setPhase(chatPhaseStarting)
	result, err := cl.RunChat(runCtx, claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       qaRunPrompt(arg, runDir, prev),
		SystemPrompt: claude.QARunSystemPrompt + explainLangTail(langFor(runCtx, tm, langpref.KindExplain)),
		WorkDir:      dir,
		// No Edit (file header of test_run.go, point 1, applies verbatim).
		Tools:     []string{"Read", "Grep", "Glob", "Bash", "mcp__playwright", "mcp__laravel-boost"},
		MCPConfig: qaMCPConfig(runDir),
		AddDirs:   []string{runDir},
		// An idle (no output) bound, not a total one — see HeartbeatContext.
		// A docker/artisan call can be silent for a while.
		Timeout:     20 * time.Minute,
		OnEvent:     qaRunProgressSink(arg.Repo, arg.PR),
		OnHeartbeat: func() { touchWriteTurnHolder(writeSlotKey) },
	})
	if err != nil {
		if runCtx.Err() != nil {
			return cancelled()
		}
		return fail("Claude kon de QA-test niet afronden. Probeer het opnieuw.")
	}
	rep, perr := parseQAReport(result.Text)
	if perr != nil {
		return fail("Claude leverde geen leesbaar QA-verslag op: " + perr.Error())
	}
	sanitizeQAReport(rep, runDir)
	res.Report = rep
	return res
}

// qaRunPrompt is the call-specific part (the static instructions live in
// prompts/qa_run.md).
func qaRunPrompt(arg qaRunArg, runDir string, prev *qaReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Test pull request #%d", arg.PR)
	if arg.Repo != "" {
		fmt.Fprintf(&b, " (repo %s)", arg.Repo)
	}
	fmt.Fprintf(&b, ". Dit is ronde %d.\n\n", arg.Round)
	fmt.Fprintf(&b, "Screenshotmap (absoluut pad, gebruik dit in elke `filename`): %s\n", runDir)
	fmt.Fprintf(&b, "Gebruik voor bestandsnamen het voorvoegsel `r%d-`.\n\n", arg.Round)
	if s := strings.TrimSpace(arg.Instructions); s != "" {
		fmt.Fprintf(&b, "Extra instructies van de reviewer:\n%s\n\n", s)
	}
	if prev != nil {
		b.WriteString("Vorige ronde (test vooral wat sindsdien veranderd is en of de aandachtspunten zijn opgelost):\n")
		if prev.HeadSHA != "" {
			fmt.Fprintf(&b, "- getest op commit %s\n", prev.HeadSHA)
		}
		for _, sc := range prev.Scenarios {
			fmt.Fprintf(&b, "- [%s] %s: %s\n", sc.Status, sc.Name, sc.Result)
		}
		for _, st := range prev.Steps {
			if st.Status == "warn" || st.Status == "fail" {
				fmt.Fprintf(&b, "- aandachtspunt: %s\n", st.Title)
			}
		}
		b.WriteString("\n")
	}
	b.WriteString("Begin met het afleiden van de scenario's, test ze in de lokale admin, en sluit af met het JSON-verslag.")
	return b.String()
}

// qaMCPConfig is the --mcp-config JSON: Playwright (headless, an in-memory
// profile, the local self-signed cert accepted, absolute screenshot paths
// allowed, `data-test` as the test-id attribute plug-and-pay uses) plus
// laravel-boost through the PHP container of the stack in the CLI's cwd (the
// werkmap). Built with encoding/json, never by string concatenation, since
// runDir is a path.
func qaMCPConfig(runDir string) string {
	cfg := map[string]any{"mcpServers": map[string]any{
		"playwright": map[string]any{
			"command": "npx",
			"args": []string{"-y", "@playwright/mcp@latest", "--headless", "--isolated",
				"--ignore-https-errors", "--allow-unrestricted-file-access",
				"--test-id-attribute", "data-test", "--viewport-size", "1440x900",
				"--output-dir", runDir},
		},
		"laravel-boost": map[string]any{
			"command": "docker",
			"args":    []string{"compose", "exec", "-T", "php", "php", "artisan", "boost:mcp"},
		},
	}}
	out, _ := json.Marshal(cfg)
	return string(out)
}

var qaRunMarkerRe = regexp.MustCompile(`(?m)^[ \t>*-]*\[slash:(qa-plan|qa-step)\][ \t]+(\S.*)$`)

// qaRunProgressSink maps the streamed CLI events onto the volatile snapshot —
// the same phase/tool mapping as testRunProgressSink plus the two marker kinds.
func qaRunProgressSink(repo string, pr int) func(claude.ChatEvent) {
	var buf string
	return func(ev claude.ChatEvent) {
		switch ev.Kind {
		case claude.ChatEventText:
			buf += ev.TextDelta
			cut := strings.LastIndexByte(buf, '\n')
			if cut < 0 {
				return
			}
			lines := buf[:cut+1]
			buf = buf[cut+1:]
			for _, m := range qaRunMarkerRe.FindAllStringSubmatch(lines, -1) {
				text := truncateTestRunText(strings.TrimSpace(m[2]), 200)
				mutateQARunProgress(repo, pr, func(p *qaRunProgress) {
					if m[1] == "qa-plan" {
						p.Plan = text
					} else if len(p.Steps) < 100 {
						p.Steps = append(p.Steps, text)
					}
				})
			}
		case claude.ChatEventThinking:
			mutateQARunProgress(repo, pr, func(p *qaRunProgress) { p.Phase, p.Tool, p.Detail = chatPhaseThinking, "", "" })
		case claude.ChatEventTool:
			mutateQARunProgress(repo, pr, func(p *qaRunProgress) {
				p.Phase, p.Tool = chatPhaseTool, ev.Tool
				if ev.Detail != "" {
					p.Detail = ev.Detail
				}
			})
		}
	}
}

var qaJSONFenceRe = regexp.MustCompile("(?s)```json[ \t]*\n(.*?)\n```")

// parseQAReport takes the LAST ```json fence of the answer (the prompt asks
// for exactly one, at the end; an earlier fence may be an example Claude
// quoted) and decodes it.
func parseQAReport(text string) (*qaReport, error) {
	all := qaJSONFenceRe.FindAllStringSubmatch(text, -1)
	if len(all) == 0 {
		return nil, fmt.Errorf("geen json-codeblok")
	}
	var rep qaReport
	if err := json.Unmarshal([]byte(all[len(all)-1][1]), &rep); err != nil {
		return nil, fmt.Errorf("ongeldige json: %v", err)
	}
	if len(rep.Steps) == 0 {
		return nil, fmt.Errorf("geen stappen")
	}
	return &rep, nil
}

// Bounds on the model-authored report before it is recorded in the workflow
// history (same spirit as test_run's caps).
const (
	qaMaxSteps     = 80
	qaMaxImages    = 12
	qaMaxText      = 6000
	qaMaxShort     = 300
	qaMaxTableRows = 40
	qaMaxTableCols = 8
)

var qaStatuses = map[string]bool{"ok": true, "warn": true, "fail": true, "info": true}

// sanitizeQAReport bounds every field, normalizes statuses, and drops any
// image that is not a plain file name actually present in runDir — so the page
// never references a file the image endpoint would refuse anyway.
func sanitizeQAReport(rep *qaReport, runDir string) {
	cut := func(s string, n int) string { return truncateTestRunText(strings.TrimSpace(s), n) }
	status := func(s string, def string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		if qaStatuses[s] {
			return s
		}
		return def
	}
	rep.Title = cut(rep.Title, qaMaxShort)
	rep.Kicker = cut(rep.Kicker, qaMaxShort)
	rep.HeadSHA = cut(rep.HeadSHA, 40)
	rep.Summary = cut(rep.Summary, qaMaxText)
	devs := []string{}
	for _, d := range rep.Deviations {
		if d = cut(d, qaMaxShort*2); d != "" && len(devs) < 30 {
			devs = append(devs, d)
		}
	}
	rep.Deviations = devs
	if rep.Scenarios == nil {
		rep.Scenarios = []qaScenario{}
	}
	if len(rep.Scenarios) > 60 {
		rep.Scenarios = rep.Scenarios[:60]
	}
	for i := range rep.Scenarios {
		sc := &rep.Scenarios[i]
		sc.Name, sc.Result, sc.Status = cut(sc.Name, qaMaxShort), cut(sc.Result, qaMaxShort), status(sc.Status, "info")
	}
	if rep.Groups == nil {
		rep.Groups = []qaGroup{}
	}
	for i := range rep.Groups {
		rep.Groups[i].ID, rep.Groups[i].Label = cut(rep.Groups[i].ID, 40), cut(rep.Groups[i].Label, 80)
	}
	if len(rep.Steps) > qaMaxSteps {
		rep.Steps = rep.Steps[:qaMaxSteps]
	}
	for i := range rep.Steps {
		st := &rep.Steps[i]
		st.Group, st.Eyebrow, st.Title = cut(st.Group, 40), cut(st.Eyebrow, qaMaxShort), cut(st.Title, qaMaxShort)
		st.Status = status(st.Status, "info")
		st.Body, st.Pre = cut(st.Body, qaMaxText), cut(st.Pre, qaMaxText)
		imgs := []qaImage{}
		for _, im := range st.Images {
			name := filepath.Base(strings.TrimSpace(im.File))
			if !qaImageFileRe.MatchString(name) || len(imgs) >= qaMaxImages {
				continue
			}
			if fi, err := os.Stat(filepath.Join(runDir, name)); err != nil || fi.IsDir() {
				continue
			}
			imgs = append(imgs, qaImage{File: name, Caption: cut(im.Caption, qaMaxShort)})
		}
		st.Images = imgs
		if len(st.Table) > qaMaxTableRows {
			st.Table = st.Table[:qaMaxTableRows]
		}
		for r := range st.Table {
			if len(st.Table[r]) > qaMaxTableCols {
				st.Table[r] = st.Table[r][:qaMaxTableCols]
			}
			for c := range st.Table[r] {
				st.Table[r][c] = cut(st.Table[r][c], qaMaxShort)
			}
		}
	}
}

// removeQAArtifactsForPR deletes a purged PR's screenshot directories
// (purgePR, cleanup.go). Idempotent.
func removeQAArtifactsForPR(dataDir string, pr int) error {
	if dataDir == "" || pr <= 0 {
		return nil
	}
	return os.RemoveAll(filepath.Join(dataDir, "qa", fmt.Sprint(pr)))
}
