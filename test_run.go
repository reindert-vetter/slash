// test_run.go — "laat Claude bepaalde tests draaien": ONE agentic run that
// itself decides which EXISTING tests are relevant to a PR's changes and runs
// only those — never the whole suite, never a fixed per-repo test command
// (reviewer decision: "wat er getest wordt bepaalt Claude zelf").
//
// Modelled directly on comment_batch.go — read that file's own header first,
// this one only calls out where test_run differs:
//
//  1. NO Edit tool. comment_batch changes code; a test run may only run
//     EXISTING tests and report outcomes, never touch code or tests. See
//     runTestRun's Tools.
//  2. NO fixed item list up front. comment_batch is handed the reviewer's own
//     confirmed comment ids; a test run has no equivalent — Claude discovers
//     both the test framework (composer.json/CI config, never assumed here in
//     Go) and which tests are relevant, at runtime. So the per-test progress
//     list (test_run_progress.go) starts EMPTY and grows as `[slash:test-start]`
//     markers arrive, rather than being pre-seeded and validated against a
//     known id space.
//  3. NO landing step. comment_batch's edits land via the chat_merge queue;
//     a test run has nothing to land — it never edits tracked files. Any
//     untracked residue a test command leaves behind (caches, logs) is
//     deliberately left in place (reviewer decision: "laat ze staan") and
//     swept later, by AGE, from the cleanup workflow — see
//     testRunResidueAge in cleanup.go. This file only DISCOVERS that residue
//     (via `git clean -ndx`) and records it, bounded, on the Activity result.
//  4. Same marker-parsing discipline as comment_batch: parsed LIVE from the
//     streamed events for the volatile snapshot, and once more from the run's
//     final text for the Activity's recorded result, so replay never depends
//     on whether a stream was observed (.claude/rules/workflow-determinism.md).
//  5. Cancel reuses chat_cancel.go's registry verbatim, under a synthetic
//     per-PR id (testRunCancelID) — no new cancel mechanism. Because every
//     claude.RunChat call already kills its own process group on a context
//     cancellation (killOwnProcessGroup, modules/claude/claude.go), cancelling
//     a test run also kills whatever test-runner child process (phpunit,
//     composer, ...) Claude's Bash tool started, however deep.
//  6. Same write-gate as a code-generating chat turn (chat_write_gate.go,
//     capacity 1) — a test run WAITS for that one slot rather than getting a
//     separate one. Deliberate: the shared local checkout is a single mutable
//     resource, and a concurrent code-edit turn's `git checkout`/`stash`
//     could otherwise swap the working tree out from under a running test
//     process (spurious failures) or interpret the test run's own residue as
//     something to stash/discard. The accepted cost is that a test run and a
//     code-edit turn now queue behind each other — visible via the existing
//     chatPhaseWaiting phase, exactly like a code-turn waiting on another
//     code-turn.
//  7. A second test_run request for the SAME PR while one is already running
//     is REFUSED (409), not queued — mirrors comment_batch's own
//     handleCommentBatchStart precedent exactly, for the same two reasons:
//     both runs would explore/execute in the SAME shared checkout at once,
//     and the per-PR progress snapshot (test_run_progress.go) can only ever
//     describe one run. Unlike the write-gate above (which exists to let two
//     DIFFERENT kinds of operation take turns), there is no reason to make
//     the reviewer wait for an identical, redundant second run of the same
//     PR — asking again once the first is done costs nothing.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/reindert-vetter/tembed"

	"slash/modules/claude"
	"slash/modules/langpref"
)

// TestRunInput is POST /api/workflows/test_run's body: just the PR. No
// selection of tests or comments — Claude decides that itself (see the file
// header).
type TestRunInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo. See repos.go.
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
}

// testRunArg is the runTestRun Activity's input: the workflow's own input plus
// the Run ID, kept purely so a future extension can derive a stable id from it
// the way chatMessageID/commentBatchConvID do — not otherwise used yet.
type testRunArg struct {
	Repo   string `json:"repo,omitempty"`
	PR     int    `json:"pr"`
	TurnID string `json:"turnId"`
}

// testRunResult is what the one agentic run reports back to the workflow —
// deliberately bounded (a few counts, a short plan/summary, a capped list of
// residue paths), never the raw CLI transcript: see the file header's point 4.
type testRunResult struct {
	Plan      string `json:"plan,omitempty"`
	Passed    int    `json:"passed"`
	Failed    int    `json:"failed"`
	Cancelled bool   `json:"cancelled,omitempty"`
	Note      string `json:"note,omitempty"`
	// ResidueDir/ResiduePaths: what `git clean -ndx` reported as untracked +
	// ignored inside the checkout right after this run — a test command can
	// leave caches/logs/coverage files behind even without any Edit tool.
	// Recorded here (bounded, see testRunResidueMax) so the cleanup workflow
	// can sweep exactly these paths once they're old enough — see
	// testRunResidueAge in cleanup.go. Never acted on immediately: "laat ze
	// staan" (reviewer decision) — only cleanup.go removes them, and only
	// once they're stale.
	ResidueDir   string   `json:"residueDir,omitempty"`
	ResiduePaths []string `json:"residuePaths,omitempty"`
}

// testRunConvID is the synthetic chat-conversation id a test run's checkout
// resolution hangs on — mirrors commentBatchConvID. One per PR: a test run is
// PR-wide, never per-comment.
func testRunConvID(pr int) string { return fmt.Sprintf("testrun-%d", pr) }

// testRunCancelID is the key a running test_run registers its cancel func
// under — reusing chat_cancel.go's registry (a plain map[string]func(), keyed
// generically, not literally "per conversation") rather than inventing a
// second cancel mechanism. See the file header, point 5.
func testRunCancelID(pr int) string { return fmt.Sprintf("testrun-%d", pr) }

// testRunWorkflow is the whole workflow: exactly one Activity, no branching —
// trivially deterministic. Unlike commentBatchWorkflow there is no second,
// conditional "enqueue landing" Activity: a test run never edits tracked
// files, so there is never anything to land (see the file header, point 3).
func testRunWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in TestRunInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if in.PR <= 0 {
		return json.Marshal(testRunResult{})
	}
	arg := testRunArg{Repo: in.Repo, PR: in.PR, TurnID: w.RunID()}
	var res testRunResult
	if err := w.ExecuteActivity("runTestRun", arg, &res); err != nil {
		return nil, fmt.Errorf("run test run: %w", err)
	}
	return json.Marshal(res)
}

// StartTestRun launches a test_run Execution for one PR. Starting an
// Execution is the sanctioned write path; StartWorkflowDeferLow so the HTTP
// request returns immediately instead of holding the browser for the whole
// agentic run — same as StartCommentBatch.
func (m *TaskManager) StartTestRun(in TestRunInput) (string, error) {
	if m.engine == nil {
		return "", fmt.Errorf("no engine")
	}
	return m.engine.StartWorkflowDeferLow(WorkflowTestRun, in)
}

// testRunMarkerRe matches the four marker lines test_run.md fixes. Mirrors
// commentBatchMarkerRe exactly, plus the "plan" kind, which comment_batch has
// no equivalent of (comment_batch's targets are already known before the run
// starts; a test run's plan is the first thing that has to be said OUT LOUD).
var testRunMarkerRe = regexp.MustCompile(`(?m)^[ \t>*-]*\[slash:(plan|test-start|test-pass|test-fail)\][ \t]+(\S.*)$`)

// testRunMarker is one parsed progress marker line. Name/Note only really
// apply to the three test-* kinds; a "plan" marker's whole rest-of-line is its
// Note.
type testRunMarker struct {
	Kind string // testRunMarkerPlan | Start | Pass | Fail
	Name string
	Note string
}

const (
	testRunMarkerPlan  = "plan"
	testRunMarkerStart = "start"
	testRunMarkerPass  = "pass"
	testRunMarkerFail  = "fail"
)

// testRunNameNoteRe splits a test-start/test-pass/test-fail marker's payload
// into "<name> <optional trailing note>" — the name is whatever comes before
// the first run of whitespace, the note (only ever present for test-fail) is
// the rest of the line, trimmed.
var testRunNameNoteRe = regexp.MustCompile(`^(\S+)[ \t]*(.*)$`)

// testRunMaxNameLen bounds a test name before it is ever stored/displayed —
// unlike comment_batch's comment ids (validated against a known allowlist),
// a test name is free text the model invents, so it needs its own length cap
// rather than a validity check.
const testRunMaxNameLen = 160

// parseTestRunMarkers extracts every marker from a piece of the answer, in
// order of appearance. Mirrors parseCommentBatchMarkers.
func parseTestRunMarkers(text string) []testRunMarker {
	matches := testRunMarkerRe.FindAllStringSubmatch(text, -1)
	out := make([]testRunMarker, 0, len(matches))
	for _, m := range matches {
		rest := strings.TrimSpace(m[2])
		switch m[1] {
		case "plan":
			out = append(out, testRunMarker{Kind: testRunMarkerPlan, Note: truncateTestRunText(rest, testRunMaxPlanLen)})
			continue
		}
		kind := testRunMarkerStart
		switch m[1] {
		case "test-pass":
			kind = testRunMarkerPass
		case "test-fail":
			kind = testRunMarkerFail
		}
		nm := testRunNameNoteRe.FindStringSubmatch(rest)
		name, note := rest, ""
		if nm != nil {
			name, note = nm[1], strings.TrimSpace(nm[2])
		}
		out = append(out, testRunMarker{
			Kind: kind,
			Name: truncateTestRunText(strings.Trim(name, "`'\"*"), testRunMaxNameLen),
			Note: truncateTestRunText(note, testRunMaxNoteLen),
		})
	}
	return out
}

// testRunMaxPlanLen/testRunMaxNoteLen bound the free-text pieces a marker can
// carry, same reasoning as testRunMaxNameLen — this is model-authored text
// that ends up in the workflow's own recorded result.
const (
	testRunMaxPlanLen = 240
	testRunMaxNoteLen = 200
)

func truncateTestRunText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// testRunResidueMax bounds how many residue paths ever get recorded on the
// Activity result — a test run gone wrong could in principle leave thousands
// of files (e.g. a build cache), and the workflow-history result must stay
// bounded (.claude/rules/workflow-determinism.md's spirit: no unbounded
// non-deterministic output in a stored result).
const testRunResidueMax = 200

// runTestRun is the runTestRun Activity's body: the one agentic Claude run.
// Never returns an error — a failure degrades to a recorded reason in the
// volatile progress (failTestRunProgress) plus a zero result, exactly like
// runCommentBatch.
func runTestRun(ctx context.Context, tm *TaskManager, cl claude.Client, dataDir string, arg testRunArg) testRunResult {
	if cl == nil {
		return testRunResult{}
	}

	startTestRunProgress(arg.Repo, arg.PR)
	defer finishTestRunProgress(arg.Repo, arg.PR)

	// runCtx is the only context a cancel touches — the reviewer's own "Stop"
	// (a POST to a dedicated test-run cancel endpoint, mirroring
	// POST /api/chat/cancel) via the CancelFunc registered here. See the file
	// header, point 5, and chat_cancel.go's own doc comment for why this can
	// never be a Signal.
	runCtx, cancel := context.WithCancel(ctx)
	unregister := registerChatCancel(testRunCancelID(arg.PR), cancel)
	defer unregister()
	defer cancel()

	// Same shared checkout every chat turn/comment_batch run uses, and the same
	// write-gate — see the file header, point 6. A test run never edits
	// anything, but it still needs the checkout to stay put WHILE it runs.
	waited := false
	release := acquireWriteTurnSlot(runCtx, func() {
		waited = true
		advanceTestRunProgress(arg.Repo, arg.PR, chatPhaseWaiting)
	})
	defer release()
	if runCtx.Err() != nil {
		return testRunResult{Cancelled: true}
	}
	if waited {
		advanceTestRunProgress(arg.Repo, arg.PR, chatPhaseStarting)
	}

	dir, decision, ok := prepareChatShellWorkDir(runCtx, tm, dataDir, arg.Repo, arg.PR, "")
	if runCtx.Err() != nil {
		return testRunResult{Cancelled: true}
	}
	if decision != nil || checkoutChoiceOpen(arg.Repo, arg.PR) {
		failTestRunProgress(arg.Repo, arg.PR, "Er staat nog een keuze open over de werkmap van deze PR. Maak die keuze en probeer het daarna opnieuw.")
		return testRunResult{}
	}
	if !ok {
		failTestRunProgress(arg.Repo, arg.PR, "Kon geen lokale werkmap klaarzetten om tests in te draaien.")
		return testRunResult{}
	}

	advanceTestRunProgress(arg.Repo, arg.PR, chatPhaseStarting)
	result, err := cl.RunChat(runCtx, claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       "Bepaal en draai de relevante tests voor deze PR.",
		SystemPrompt: claude.TestRunSystemPrompt + explainLangTail(langFor(runCtx, tm, langpref.KindExplain)),
		WorkDir:      dir,
		// Deliberately NO Edit — see the file header, point 1.
		Tools:   []string{"Read", "Grep", "Glob", "Bash"},
		OnEvent: testRunProgressSink(arg.Repo, arg.PR),
	})
	res := testRunResult{}
	if err != nil {
		if runCtx.Err() != nil {
			res.Cancelled = true
			markTestRunCancelled(arg.Repo, arg.PR)
		} else {
			failTestRunProgress(arg.Repo, arg.PR, "Claude kon de tests niet draaien. Probeer het opnieuw.")
		}
		res.ResidueDir, res.ResiduePaths = collectTestRunResidue(ctx, dir)
		return res
	}

	// The recorded result comes from the final text only (see the file
	// header's point 4), exactly like comment_batch.
	for _, mk := range parseTestRunMarkers(result.Text) {
		switch mk.Kind {
		case testRunMarkerPlan:
			res.Plan = mk.Note
		case testRunMarkerPass:
			res.Passed++
		case testRunMarkerFail:
			res.Failed++
		}
	}
	res.Note = testRunSummaryNote(result.Text)
	// The residue check uses ctx (the Activity's original, uncancelled
	// context), never runCtx — the run itself already finished by this point,
	// so there's nothing left to cancel, but a `git clean` read should still
	// complete even if the reviewer clicked Stop in the same instant.
	res.ResidueDir, res.ResiduePaths = collectTestRunResidue(ctx, dir)
	return res
}

// testRunSummaryNote takes the run's own closing summary — everything after
// the LAST marker line — trimmed and bounded, so the progress panel can show
// something more useful than a bare pass/fail count once the run is done.
func testRunSummaryNote(text string) string {
	matches := testRunMarkerRe.FindAllStringIndex(text, -1)
	tail := text
	if len(matches) > 0 {
		last := matches[len(matches)-1]
		// Skip to the end of that marker's own line.
		if nl := strings.IndexByte(text[last[1]:], '\n'); nl >= 0 {
			tail = text[last[1]+nl+1:]
		} else {
			tail = ""
		}
	}
	return truncateTestRunText(strings.TrimSpace(tail), 400)
}

// collectTestRunResidue lists what `git clean -ndx` (dry run: untracked +
// ignored files) reports for dir right now, bounded to testRunResidueMax —
// see the file header, point 3. Best-effort: any error (dir gone, not a git
// repo) yields no residue rather than failing the whole Activity.
func collectTestRunResidue(ctx context.Context, dir string) (string, []string) {
	if dir == "" {
		return "", nil
	}
	out, err := runGitIn(ctx, dir, "clean", "-ndx")
	if err != nil {
		return "", nil
	}
	var paths []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		// git clean -n prints "Would remove <path>" / "Would skip repository <path>".
		path, ok := strings.CutPrefix(line, "Would remove ")
		if !ok {
			continue
		}
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		paths = append(paths, path)
		if len(paths) >= testRunResidueMax {
			break
		}
	}
	if len(paths) == 0 {
		return "", nil
	}
	return dir, paths
}

// testRunProgressSink builds the OnEvent callback that maps the streamed CLI
// events onto the run's volatile progress snapshot: the same phase/tool
// mapping as commentBatchProgressSink, plus the marker lines that add/advance
// a single test's row while the run is still going. Unlike
// commentBatchProgressSink there is no known id allowlist — a test's name is
// whatever the model reports, added to the list the first time it's seen (see
// the file header, point 2).
func testRunProgressSink(repo string, pr int) func(claude.ChatEvent) {
	var buf string
	return func(ev claude.ChatEvent) {
		switch ev.Kind {
		case claude.ChatEventText:
			buf += ev.TextDelta
			cut := strings.LastIndexByte(buf, '\n')
			if cut < 0 {
				return
			}
			lines, rest := buf[:cut+1], buf[cut+1:]
			buf = rest
			for _, mk := range parseTestRunMarkers(lines) {
				switch mk.Kind {
				case testRunMarkerPlan:
					markTestRunPlan(repo, pr, mk.Note)
				case testRunMarkerStart:
					markTestRunCurrent(repo, pr, mk.Name)
				case testRunMarkerPass:
					markTestRunOutcome(repo, pr, mk.Name, testRunStatePass, mk.Note)
				case testRunMarkerFail:
					markTestRunOutcome(repo, pr, mk.Name, testRunStateFail, mk.Note)
				}
			}
		case claude.ChatEventThinking:
			if snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
				p.Phase, p.Tool, p.Detail = chatPhaseThinking, "", ""
			}); ok {
				publishTestRunProgress(repo, pr, snap)
			}
		case claude.ChatEventTool:
			if snap, ok := mutateTestRunProgress(repo, pr, func(p *testRunProgress) {
				p.Phase, p.Tool = chatPhaseTool, ev.Tool
				if ev.Detail != "" {
					p.Detail = ev.Detail
				}
			}); ok {
				publishTestRunProgress(repo, pr, snap)
			}
		}
	}
}
