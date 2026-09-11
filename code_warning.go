package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/bits"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/warndismiss"
	"slash/modules/warnreviewed"
)

// This file is the LLM side of the code_warning workflow (package main; it
// reads the head worktree and shells out to the claude CLI, so it runs only
// inside a code_warning Activity). Unlike resolve_call/resolve_test_covers
// (Haiku first, agentic Sonnet only as an escalation that this repo has since
// removed), this workflow uses ONLY one agentic pass — deliberately: the
// whole point is to explore the checked-out repo for risks connected to, but
// not necessarily inside, the changed lines themselves (a caller a changed
// signature broke, a test still asserting the old shape, an event listener
// that doesn't handle a new payload field, …), which a context-only Haiku
// call — fed only what we chose to hand it — cannot discover on its own. The
// agentic model is Opus (claude.ModelOpus) — this is the "Diepgravend
// onderzoek" ("in-depth investigation") PR-wide menu item, deliberately the
// strongest available model since it's a manually-triggered, low-frequency
// action rather than something run on every navigation step.
// See the "AI-risicocontrole" decision in .claude/docs/tembed-workflows.md.

// warningReviewArg is the payload of the runAgenticReview Activity.
type warningReviewArg struct {
	// Repo is the canonical repo string ("" = the primary repo, see repos.go).
	Repo        string   `json:"repo,omitempty"`
	PR          int      `json:"pr"`
	Files       []string `json:"files"`
	BlockCount  int      `json:"blockCount"`
	MaxFindings int      `json:"maxFindings"`
	// Lang is the reviewer's language preference for the findings' own text
	// ("nl"|"en", modules/langpref), turned into the system-prompt tail by
	// explainLangTail (langdirective.go). Filled in by the runAgenticReview
	// Activity (workflows.go) rather than by the workflow body: reading a
	// preference store is a side effect, so it may only happen inside an
	// Activity (see .claude/rules/workflow-determinism.md). A run that
	// predates this field simply carries "", i.e. Dutch.
	Lang string `json:"lang,omitempty"`
	// Title/Description/JiraDescription carry the PR's own stated intent (from
	// prmeta, see warningScope): the reviewer often explains there WHY a choice
	// was made, and a "risk" the description already accounts for is noise. The
	// model is told to weigh them before flagging (code_warning.md).
	Title           string `json:"title,omitempty"`
	Description     string `json:"description,omitempty"`
	JiraDescription string `json:"jiraDescription,omitempty"`
	// Existing is the open, non-AI conversation already on this PR (Source !=
	// "ai" — an old AI comment in scope was already deleted by
	// supersedeFileWarnings before this Activity runs): the line comments on a
	// file in scope, the PR-wide comments, and each thread's replies. Same
	// purpose as the two description fields — it says what has already been
	// discussed — so the model can tell whether a risk it wants to flag has
	// already been raised. Whether a finding still adds something new is the
	// model's own call (see code_warning.md's system prompt); this is context,
	// not a Go-side dedup filter.
	Existing []existingLineComment `json:"existing,omitempty"`
	// PastDismissed is every AI finding the reviewer already resolved or
	// deleted, on a file in scope, in an EARLIER run of this check
	// (modules/warndismiss) — its own file + wording, not just the fingerprint
	// hash. Handed to the model so it can also recognise a REWORDED repeat of
	// one of these (the fingerprint filter in dropDismissedFindings only
	// catches a near-exact repeat). Deliberately best-effort context, exactly
	// like Existing above — not a second Go-side hard filter; that hard floor
	// (dropDismissedFindings) still runs unconditionally after this call.
	PastDismissed []dismissedFinding `json:"pastDismissed,omitempty"`
	// MaxTurns bounds the number of agentic steps (the CLI's own num_turns —
	// see ChatEventTurn) this run may take before it is asked to wrap up
	// early instead of exploring further. 0 (or unset — an older recorded
	// run replayed after this field was added) means unlimited: no nudge is
	// ever sent, the pre-existing behaviour. Filled in by the
	// runAgenticReview Activity (workflows.go) via codeWarningMaxTurns, not
	// by the workflow body — see that function's own doc comment for why.
	MaxTurns int `json:"maxTurns,omitempty"`
}

// dismissedFinding is one earlier AI finding the reviewer dismissed, scoped
// to a file in this run's review scope (see dismissedFindingsInScope).
type dismissedFinding struct {
	File string `json:"file"`
	Text string `json:"text"`
}

// existingLineComment is one open, non-AI thread already on the PR, handed to
// the model as context (see warningReviewArg.Existing): either anchored to a
// file+line in the review scope, or PR-wide (File empty, Line 0). Replies are
// carried along because that is usually where the "yes, deliberate, because
// …" answer lives.
type existingLineComment struct {
	File    string   `json:"file"`
	Line    int      `json:"line"`
	Author  string   `json:"author"`
	Body    string   `json:"body"`
	Replies []string `json:"replies,omitempty"` // "<author>: <body>", in stored order
	// ID is only used to order the PR-wide entries deterministically; it is
	// never rendered into the prompt.
	ID string `json:"id,omitempty"`
}

// warningFinding is one entry of the JSON array the model is asked to return.
type warningFinding struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// warningAuthor is the display name every AI-authored warning comment carries
// (avatarHTML falls back to its first two letters — "AI" — for the initials
// circle, since these comments never carry an avatar URL).
const warningAuthor = "AI-controle"

// Turn-budget scaling constants for codeWarningMaxTurnsForScope. Measured
// against 106 real, UNBOUNDED runs (week 2026-08-29..09-04 — no turn limit
// existed yet, so this is what the model spent when left to decide for
// itself), bucketed by review-scope file count:
//
//	scope files   n    mean scope   mean turns   ctx tokens/run
//	1             24   1.0          11.9         1.07 M
//	2-3           28   2.3          12.0         1.16 M
//	4-8           31   5.2          18.1         1.93 M
//	9-25          17   12.5         19.1         2.17 M
//	>25            6   88.3         27.0         4.01 M
//
// Population mean 15.7 turns / 1.70 M tokens per run. Turns grow with scope,
// but only weakly and sublinearly: Pearson r = 0.16 against the raw file
// count, r = 0.34 against log(scope) — an 88-file run took barely over
// double the turns a 1-file run took, not 88 times as many. A per-file
// linear cap is therefore provably wrong (it would allow 276 turns on a
// 276-file PR, where the model itself only used 27 on an 88-file one).
// Separately, 94% of findings were already anchored to a file the model had
// touched within the FIRST HALF of its own turns, while that second half
// alone accounted for 58% of the tokens (context grows ~3.5k tokens/turn and
// every turn resends the whole prefix) — so a generous cap is more expensive
// than it looks, and there is little to gain past a modest ceiling.
//
// codeWarningMaxTurnsForScope therefore grows the cap logarithmically with
// the file count (one "step" per doubling, via bits.Len — the integer
// analogue of floor(log2(n))+1) between a floor and a ceiling:
//
//   - Floor 6: close to the mean-turns floor already observed for the
//     smallest scopes (a 1-2 file PR), so a tiny PR still gets enough room to
//     read the file, follow a caller, and answer.
//   - Step 3 turns per doubling of file count: 1 file -> 9, 5 files -> 15,
//     25 files -> 21 — each roughly matching the mean-turns column above for
//     that scope bucket, without extrapolating linearly past it.
//   - Ceiling 24: comfortably above every bucket mean up to >25 files (27
//     turns unbounded) yet well under the 77 turns the single largest
//     fixture (88 files) actually took unbounded — the point is to cut off
//     the expensive long tail, not to match it. A >25-file scope (e.g. 276
//     files) clamps at this ceiling rather than growing further, since the
//     weak scope->turns correlation means more files does not reliably mean
//     proportionally more to find.
const (
	codeWarningScopeFloor = 6
	codeWarningScopeStep  = 3
	codeWarningScopeCeil  = 24
)

// codeWarningMaxTurnsForScope is the pure formula behind the default turn
// budget: codeWarningScopeFloor + codeWarningScopeStep * bits.Len(fileCount),
// clamped to codeWarningScopeCeil. bits.Len(n) is 0 for n==0 and otherwise
// floor(log2(n))+1, so the budget grows by one step per doubling of the
// scope's file count — see the constants' own doc comment for the
// measurement this is calibrated against.
func codeWarningMaxTurnsForScope(fileCount int) int {
	if fileCount < 0 {
		fileCount = 0
	}
	n := codeWarningScopeFloor + codeWarningScopeStep*bits.Len(uint(fileCount))
	if n > codeWarningScopeCeil {
		return codeWarningScopeCeil
	}
	return n
}

// codeWarningMaxTurns resolves the turn budget for one code_warning run:
// SLASH_CODE_WARNING_MAX_TURNS when it parses as a positive integer (an
// explicit override always wins), "0" or "unlimited" (case-insensitive) to
// explicitly disable the budget (used for the "onbeperkt" measurement
// baseline), otherwise codeWarningMaxTurnsForScope(fileCount) — including
// when the env var is set but unparsable, so a typo falls back to the
// scope-scaled default rather than silently meaning unlimited. Called from
// inside the runAgenticReview Activity (workflows.go), never from the
// workflow body itself: reading an environment variable is a side effect,
// and the workflow body must stay a pure function of (input + history) —
// see .claude/rules/workflow-determinism.md.
func codeWarningMaxTurns(fileCount int) int {
	s := strings.TrimSpace(os.Getenv("SLASH_CODE_WARNING_MAX_TURNS"))
	if s == "" {
		return codeWarningMaxTurnsForScope(fileCount)
	}
	if s == "0" || strings.EqualFold(s, "unlimited") {
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return codeWarningMaxTurnsForScope(fileCount)
}

// codeWarningStopNudge is the one steer message sent to a running review
// once it has used up its turn budget (see codeWarningTurnCounter). It asks
// for exactly the JSON contract claude.CodeWarningSystemPrompt already
// specifies, so the model's very next step can be its final answer instead
// of another exploration step — a half-finished list of real findings beats
// an empty one.
const codeWarningStopNudge = "You have used up your turn budget for this review. Stop investigating further right now and respond immediately with the JSON array of findings, following the rules in the system prompt, based only on what you found so far. If you found nothing worth flagging yet, respond with an empty array []."

// codeWarningTurnCounter returns a claude.RunRequest.OnEvent callback that
// counts ChatEventTurn events (one per agentic step — see that constant's
// own doc comment) and, the FIRST time the count reaches maxTurns, sends
// codeWarningStopNudge on steer and closes it. maxTurns <= 0 means
// unlimited: the returned callback still counts (harmlessly) but never
// sends. The returned *bool reports, after the call, whether the nudge was
// actually sent — the caller logs that as an expected, non-error outcome.
//
// Safe without a mutex: RunChat calls OnEvent serially from its own single
// stream-reading goroutine (see RunRequest.OnEvent's own doc comment), and
// this closure's state (turns, nudged) is touched from nowhere else. The
// send itself is non-blocking into a capacity-1 channel guarded by nudged,
// so it can never block that same reading goroutine.
func codeWarningTurnCounter(maxTurns int, steer chan<- string) (func(claude.ChatEvent), *bool) {
	turns := 0
	nudged := new(bool)
	onEvent := func(ev claude.ChatEvent) {
		if ev.Kind != claude.ChatEventTurn {
			return
		}
		turns++
		if maxTurns > 0 && turns >= maxTurns && !*nudged {
			*nudged = true
			select {
			case steer <- codeWarningStopNudge:
			default:
			}
			close(steer)
		}
	}
	return onEvent, nudged
}

// runCodeWarningReview makes the one agentic Opus call and returns the
// accepted findings — verified against the scope the model was actually
// given (never a fabricated file), sorted, and capped at arg.MaxFindings.
// Never returns an error: a model/CLI failure degrades to no findings (like
// resolveCallsWithModel), so the workflow always completes.
//
// The second return value, ok, is true only when the agentic call actually
// ran and returned (even if it reported zero findings) — false when there was
// nothing to review or the CLI call itself failed. The caller
// (runAgenticReview, workflows.go) uses it to decide whether the files in
// scope may be recorded as reviewed (modules/warnreviewed): a call that never
// really happened must not be recorded as having checked anything.
func runCodeWarningReview(ctx context.Context, cl claude.Client, dataDir string, arg warningReviewArg) ([]warningFinding, bool) {
	if cl == nil || len(arg.Files) == 0 {
		return nil, false
	}
	baseDir, headDir := worktreeDirs(dataDir, arg.Repo, arg.PR)
	// Which lines this PR actually changed, per file in scope — used twice: to
	// TELL the model where it may anchor (warningPrompt) and to ENFORCE it
	// afterwards (the changed-lines guard below), the same
	// instruct-plus-verify shape the file-scope hallucination guard already
	// has. Computed once here rather than per finding: it shells out to git
	// per file.
	changed := changedLineSets(baseDir, headDir, arg.Files)

	// Turn budget: once arg.MaxTurns agentic steps have gone by, steer the
	// running turn (see RunRequest.Steer) into wrapping up immediately with
	// whatever it has found so far, rather than letting it keep exploring —
	// see codeWarningStopNudge and the package doc comment above for the
	// measurement this is based on. arg.MaxTurns <= 0 means unlimited: the
	// channel is still wired (RunChat needs a non-nil Steer to know it may
	// receive one) but codeWarningTurnCounter never sends on it.
	steer := make(chan string, 1)
	onEvent, nudged := codeWarningTurnCounter(arg.MaxTurns, steer)
	req := claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       warningPrompt(arg, changed),
		SystemPrompt: claude.CodeWarningSystemPrompt + explainLangTail(arg.Lang),
		WorkDir:      headDir,
		Tools:        []string{"Read", "Grep", "Glob"},
		OnEvent:      onEvent,
		Steer:        steer,
	}
	res, err := cl.RunChat(ctx, req)
	if err != nil {
		return nil, false
	}
	// Logged unconditionally (not just when nudged): this is the one place
	// that can compare an unlimited run against a bounded one on real data
	// (turns/cost/tokens vs. findings kept, once combined with the "found"
	// count codeWarningWorkflow logs) — see the turn-budget measurement in
	// .claude/docs/workflows-analysis.md.
	u := res.Usage
	log.Printf("code_warning: pr %d review done — scopeFiles=%d maxTurns=%d cliTurns=%d nudged=%v cost=$%.4f tokens(in=%d out=%d cacheRead=%d cacheCreate=%d)",
		arg.PR, len(arg.Files), arg.MaxTurns, u.NumTurns, *nudged, u.TotalCostUSD, u.InputTokens, u.OutputTokens, u.CacheReadInputTokens, u.CacheCreationInputTokens)
	findings := parseWarningFindings(res.Text)

	// Hallucination guard: only trust a finding whose file is one we actually
	// told the model about — never a fabricated path elsewhere in the worktree.
	allowed := make(map[string]bool, len(arg.Files))
	for _, f := range arg.Files {
		allowed[f] = true
	}
	kept := make([]warningFinding, 0, len(findings))
	for _, f := range findings {
		if f.File == "" || f.Line <= 0 || strings.TrimSpace(f.Text) == "" || !allowed[f.File] {
			continue
		}
		// Changed-lines guard (see changedLineSets): the model may LOOK
		// anywhere, but a finding must anchor on a line this PR actually
		// touched. Dropped outright — deliberately not demoted to a PR-wide
		// finding, so an unrelated remark about untouched code simply
		// disappears instead of resurfacing without an anchor.
		if !changed[f.File].allows(f.Line) {
			continue
		}
		kept = append(kept, f)
	}
	sort.Slice(kept, func(i, j int) bool {
		if kept[i].File != kept[j].File {
			return kept[i].File < kept[j].File
		}
		return kept[i].Line < kept[j].Line
	})
	if arg.MaxFindings > 0 && len(kept) > arg.MaxFindings {
		kept = kept[:arg.MaxFindings]
	}
	return kept, true
}

// changedLineSets returns, per file in scope, the head-side lines this PR
// changed — reusing changedNewLines (callresolve_analysis.go), so "changed"
// means exactly what classified a block as modified, and an added file (no
// base copy) counts as changed in its entirety.
func changedLineSets(baseDir, headDir string, files []string) map[string]*fileChangeSet {
	out := make(map[string]*fileChangeSet, len(files))
	for _, f := range files {
		out[f] = changedNewLines(baseDir, headDir, f)
	}
	return out
}

// allows reports whether line is one the PR changed. A nil set (a file we
// never diffed) and a non-restricting one (an added file) allow everything —
// the same permissive fallback keepChanged already uses, so a missing base
// worktree can never silently swallow every finding.
func (fc *fileChangeSet) allows(line int) bool {
	if fc == nil || !fc.restrict {
		return true
	}
	return fc.set[line]
}

// describeChangedLines renders a file's changed lines as compact ranges
// ("12-18, 44") for the prompt, so the model can aim at a line it is allowed
// to anchor on instead of spending findings that the guard then drops. An
// added file (nothing to restrict) says so in words rather than listing every
// line of the file.
func describeChangedLines(fc *fileChangeSet) string {
	if fc == nil || !fc.restrict {
		return "the whole file is new"
	}
	lines := make([]int, 0, len(fc.set))
	for ln := range fc.set {
		lines = append(lines, ln)
	}
	if len(lines) == 0 {
		return "no changed lines"
	}
	sort.Ints(lines)
	var parts []string
	start, prev := lines[0], lines[0]
	flush := func() {
		if start == prev {
			parts = append(parts, fmt.Sprintf("%d", start))
			return
		}
		parts = append(parts, fmt.Sprintf("%d-%d", start, prev))
	}
	for _, ln := range lines[1:] {
		if ln == prev+1 {
			prev = ln
			continue
		}
		flush()
		start, prev = ln, ln
	}
	flush()
	return strings.Join(parts, ", ")
}

// warningPrompt builds the call-specific part of the prompt: the scope
// (changed files + the lines changed in each) and the finding cap. The
// call-independent task framing and JSON contract are static across every
// code_warning run, so they travel separately as
// claude.CodeWarningSystemPrompt (--append-system-prompt) — see
// runCodeWarningReview and modules/claude/prompts.go.
func warningPrompt(arg warningReviewArg, changed map[string]*fileChangeSet) string {
	var b strings.Builder
	// The PR's own intent first, so everything below is read in its light: a
	// choice the author already explained is not a finding.
	if t := strings.TrimSpace(arg.Title); t != "" {
		fmt.Fprintf(&b, "PR title: %s\n\n", t)
	}
	if d := clipForPrompt(arg.Description, maxPromptDescription); d != "" {
		fmt.Fprintf(&b, "PR description:\n%s\n\n", d)
	}
	if d := clipForPrompt(arg.JiraDescription, maxPromptDescription); d != "" {
		fmt.Fprintf(&b, "Description of the linked Jira ticket:\n%s\n\n", d)
	}
	b.WriteString("Changed files in this PR to review, with the lines this PR changed in each:\n")
	for _, f := range arg.Files {
		fmt.Fprintf(&b, "- %s (changed lines: %s)\n", f, describeChangedLines(changed[f]))
	}
	b.WriteString("\nYou may read anything in the repository, but every finding must anchor on one of those changed lines and must be caused by this change.\n")
	fmt.Fprintf(&b, "\nThese files together touch %d changed function(s)/method(s). Report at most %d findings in total across all of them — on average about %d per changed function, never a fixed count per file — prioritizing the most important, best-justified risks over completeness.\n",
		arg.BlockCount, arg.MaxFindings, warningsPerBlock)
	if len(arg.Existing) > 0 {
		b.WriteString("\nThe open conversation already on this PR — line comments on the files above, and PR-wide comments — with their replies (see the system prompt's rule about them before reporting a finding they already cover):\n")
		for _, c := range arg.Existing {
			where := "(PR-wide)"
			if c.File != "" && c.Line > 0 {
				where = fmt.Sprintf("%s:%d", c.File, c.Line)
			} else if c.File != "" {
				where = c.File
			}
			fmt.Fprintf(&b, "- %s — %s: %s\n", where, c.Author, clipForPrompt(c.Body, maxPromptComment))
			for _, r := range c.Replies {
				fmt.Fprintf(&b, "    reply — %s\n", clipForPrompt(r, maxPromptComment))
			}
		}
	}
	if len(arg.PastDismissed) > 0 {
		b.WriteString("\nFindings the reviewer already dismissed (resolved or deleted) in an earlier run of this check, on these same files — do not report one of these again, including a reworded version that makes essentially the same point (see the system prompt's rule about them):\n")
		for _, d := range arg.PastDismissed {
			fmt.Fprintf(&b, "- %s: %s\n", d.File, clipForPrompt(d.Text, maxPromptComment))
		}
	}
	return b.String()
}

// Prompt budgets. A PR description, a Jira description or a long comment
// thread can be arbitrarily large, and this prompt already carries the file
// scope; clipping keeps one runaway field from crowding out everything else.
// Generous on purpose — the point is a ceiling, not a summary.
const (
	maxPromptDescription = 4000
	maxPromptComment     = 800
	maxPromptComments    = 60
)

// clipForPrompt trims a free-text field and cuts it to at most max runes,
// marking the cut so the model knows it is reading a fragment rather than a
// complete text.
func clipForPrompt(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + " […]"
}

// parseWarningFindings extracts the first [...] JSON array from the model
// output (models sometimes wrap it in prose or fences) and unmarshals it.
func parseWarningFindings(raw string) []warningFinding {
	start := strings.IndexByte(raw, '[')
	end := strings.LastIndexByte(raw, ']')
	if start < 0 || end <= start {
		return nil
	}
	var findings []warningFinding
	if err := json.Unmarshal([]byte(raw[start:end+1]), &findings); err != nil {
		return nil
	}
	return findings
}

// warningVerifyArg is the payload of the verifyCodeWarningFindings Activity —
// the SECOND, independent agentic pass that tries to DISPROVE each finding
// the first pass (runCodeWarningReview) reported, before any of them is
// created as a comment. See .claude/docs/workflows-analysis.md, "A second
// pass verifies each finding is actually true".
type warningVerifyArg struct {
	Repo string `json:"repo,omitempty"`
	PR   int    `json:"pr"`
	// Findings is the finished, anchored batch (already through the orphan
	// retry) restated as plain file/line/text — Text is the comment body the
	// first pass produced. Order defines each finding's 0-based index, which
	// warningRejection.Index refers back to.
	Findings []warningFinding `json:"findings"`
}

// warningRejection is one entry of the verify pass's JSON answer: a finding
// (by its 0-based index into warningVerifyArg.Findings) that pass could
// actually demonstrate is NOT true, plus why. A finding the pass did not
// (or could not) disprove simply has no entry here — see
// runCodeWarningVerification's own doc comment for why that is a deliberate
// fail-open default rather than requiring every finding to be confirmed.
type warningRejection struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

// runCodeWarningVerification makes the second, independent agentic call
// (claude.ModelSonnet — deliberately NOT the first pass's Opus, so this is a
// genuinely separate opinion rather than the same conversation agreeing with
// itself) that tries to DISPROVE each finding against the real code, with the
// same Read/Grep/Glob access to the head worktree the first pass had.
//
// Deliberately FAIL-OPEN: a nil client, no findings to check, a CLI/model
// error, or an unparseable/empty response all return nil (nothing rejected,
// every finding survives) rather than treating uncertainty as "reject
// everything". That is the opposite default from runCodeWarningReview's own
// "a CLI failure means no findings" — but the two failures aren't
// symmetrical: there, a failed FIRST pass has found nothing yet, so
// degrading to zero findings loses nothing real. Here, a failed SECOND pass
// would otherwise silently discard findings the first pass already
// established with its own agentic exploration — the same "uncertainty must
// never silently skip a review" reasoning filesNeedingReview already applies
// to the unrelated per-file-hash skip above. Only an EXPLICIT, parsed
// rejection (the model naming a specific index it could actually disprove)
// removes a finding.
func runCodeWarningVerification(ctx context.Context, cl claude.Client, dataDir string, arg warningVerifyArg) []warningRejection {
	if cl == nil || len(arg.Findings) == 0 {
		return nil
	}
	_, headDir := worktreeDirs(dataDir, arg.Repo, arg.PR)
	req := claude.RunRequest{
		Model:        claude.ModelSonnet,
		Prompt:       warningVerifyPrompt(arg),
		SystemPrompt: claude.CodeWarningVerifySystemPrompt,
		WorkDir:      headDir,
		Tools:        []string{"Read", "Grep", "Glob"},
	}
	res, err := cl.RunChat(ctx, req)
	if err != nil {
		log.Printf("code_warning: pr %d verify pass failed (%v) — keeping all %d finding(s) unverified", arg.PR, err, len(arg.Findings))
		return nil
	}
	return parseWarningRejections(res.Text, len(arg.Findings))
}

// warningVerifyPrompt lists every finding to verify, numbered — the number is
// what the model echoes back in warningRejection.Index, the same "an index is
// far more reliable to reproduce than an id" reasoning comment_titles.go uses
// for its own numbered list.
func warningVerifyPrompt(arg warningVerifyArg) string {
	var b strings.Builder
	b.WriteString("Findings to verify:\n")
	for i, f := range arg.Findings {
		fmt.Fprintf(&b, "%d. %s:%d — %s\n", i, f.File, f.Line, f.Text)
	}
	return b.String()
}

// parseWarningRejections extracts the first [...] JSON array from the verify
// pass's output and keeps only well-formed entries: an index that is out of
// range for the n findings actually sent, or a repeat of an already-seen
// index, is dropped rather than trusted — same defensive shape as
// parseWarningFindings/the hallucination guard in runCodeWarningReview.
func parseWarningRejections(raw string, n int) []warningRejection {
	start := strings.IndexByte(raw, '[')
	end := strings.LastIndexByte(raw, ']')
	if start < 0 || end <= start {
		return nil
	}
	var out []warningRejection
	if err := json.Unmarshal([]byte(raw[start:end+1]), &out); err != nil {
		return nil
	}
	kept := make([]warningRejection, 0, len(out))
	seen := make(map[int]bool, len(out))
	for _, r := range out {
		if r.Index < 0 || r.Index >= n || seen[r.Index] {
			continue
		}
		seen[r.Index] = true
		kept = append(kept, r)
	}
	return kept
}

// existingLineCommentsInScope collects the PR's open, non-AI conversation as
// context for the model (warningReviewArg.Existing), so it can tell whether a
// risk it wants to flag has already been raised — and, just as often, already
// answered in a reply. Two kinds are kept:
//
//   - a line comment (Kind "") anchored on a file in scope, and
//   - a PR-wide comment (issue/review/review_summary — see isPRWide), which
//     has no file:line but is exactly where "we chose X because Y" tends to
//     be written.
//
// Source "ai" is excluded defensively — supersedeFileWarnings already deletes
// every AI comment in scope before this runs — and Status must be "open" (a
// resolved thread is treated as already handled). Replies come along in
// stored order, minus this app's own "/resolve"/"/reopen" sentinels (status
// traces, not text a reader wrote). Ordering is deterministic: scoped line
// comments by file+line first, then the PR-wide ones by id; the whole list is
// capped at maxPromptComments so a heavily discussed PR can't crowd the
// prompt out.
func existingLineCommentsInScope(list []comments.Comment, files []string) []existingLineComment {
	allowed := make(map[string]bool, len(files))
	for _, f := range files {
		allowed[f] = true
	}
	var scoped, prWide []existingLineComment
	for _, c := range list {
		if c.Source == "ai" || c.Status != "open" {
			continue
		}
		inScope := c.Kind == "" && c.Line > 0 && allowed[c.File]
		if !inScope && !isPRWide(c.Kind) {
			continue
		}
		entry := existingLineComment{File: c.File, Author: c.Author, Body: c.Body}
		if inScope {
			entry.Line = c.Line
		}
		for _, r := range c.Reactions {
			body := strings.TrimSpace(r.Body)
			if body == "" || body == resolveSentinel || body == reopenSentinel {
				continue
			}
			entry.Replies = append(entry.Replies, r.Author+": "+body)
		}
		if inScope {
			scoped = append(scoped, entry)
		} else {
			entry.ID = c.ID
			prWide = append(prWide, entry)
		}
	}
	sort.SliceStable(scoped, func(i, j int) bool {
		if scoped[i].File != scoped[j].File {
			return scoped[i].File < scoped[j].File
		}
		return scoped[i].Line < scoped[j].Line
	})
	sort.SliceStable(prWide, func(i, j int) bool { return prWide[i].ID < prWide[j].ID })
	out := append(scoped, prWide...)
	if len(out) > maxPromptComments {
		out = out[:maxPromptComments]
	}
	return out
}

// hashHeadFiles reads each file's CURRENT content from the head worktree and
// returns its warnreviewed hash, keyed by file — used both to decide which
// files still need a review (filesNeedingReview) and, after a successful
// review, to record what was just reviewed. A file that cannot be read right
// now (missing, permission error, worktree not ready, …) is left OUT of the
// result on purpose: filesNeedingReview treats an absent entry as "unknown,
// must review", never as "unchanged" — an unreadable file must never silently
// drop out of scope.
func hashHeadFiles(headDir string, files []string) map[string]string {
	out := make(map[string]string, len(files))
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(headDir, f))
		if err != nil {
			continue
		}
		out[f] = warnreviewed.HashContent(data)
	}
	return out
}

// filesNeedingReview narrows files down to the ones code_warning must still
// spend an agentic Opus call on: a file is dropped from scope only when ITS
// OWN current head hash (currentHash, from hashHeadFiles) is both KNOWN and
// equal to the hash it was reviewed at last time (reviewedHash, see
// modules/warnreviewed). File-level, not line-level, per the reviewer's own
// request ("ai warnings alleen genereren op code wat niet eerder al
// gecontroleerd is") — an unrelated one-line change anywhere in the file
// still puts the whole file back in scope, since that already-computed hash
// covers the whole file.
//
// A file missing from currentHash (hashHeadFiles could not read it just now)
// is NEVER dropped — uncertainty must never silently skip a review; a
// redundant call is the accepted trade-off, a missed one is not.
func filesNeedingReview(files []string, currentHash, reviewedHash map[string]string) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		cur, ok := currentHash[f]
		if !ok || cur != reviewedHash[f] {
			out = append(out, f)
		}
	}
	return out
}

// dismissedFindingsInScope filters the PR's full dismissed-finding history
// (modules/warndismiss.List) down to the files this run is actually
// reviewing, mirroring existingLineCommentsInScope's own scoping — a
// dismissal on a file outside scope is irrelevant noise for this prompt. A
// row with no stored text (dismissed before the text column existed) is
// skipped: there is nothing useful to hand the model. Sorted (file, text) for
// a deterministic prompt and capped at maxPromptComments for the same reason
// existingLineCommentsInScope caps its own list.
func dismissedFindingsInScope(dismissed []warndismiss.DismissedFinding, files []string) []dismissedFinding {
	allowed := make(map[string]bool, len(files))
	for _, f := range files {
		allowed[f] = true
	}
	out := make([]dismissedFinding, 0, len(dismissed))
	for _, d := range dismissed {
		if d.Text == "" || !allowed[d.File] {
			continue
		}
		out = append(out, dismissedFinding{File: d.File, Text: d.Text})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Text < out[j].Text
	})
	if len(out) > maxPromptComments {
		out = out[:maxPromptComments]
	}
	return out
}

// dropDismissedFindings removes every finding the reviewer already dealt with
// in an earlier run of this check — resolved or deleted, recorded per
// (pr, file, fingerprint) by modules/warndismiss. Without it the automatic
// re-run after each new commit kept handing the same remark back as a fresh
// open comment, since supersedeFileWarnings wipes the previous findings first
// (reported: "ik kan ai waarschuwing niet resolven of verwijderen").
//
// Best-effort: a nil store or a read error leaves the findings untouched — a
// bookkeeping problem must never swallow a real risk.
func dropDismissedFindings(ctx context.Context, store *warndismiss.Module, repo string, pr int, findings []warningFinding) []warningFinding {
	if store == nil || len(findings) == 0 {
		return findings
	}
	dismissed, err := store.Fingerprints(ctx, repo, pr)
	if err != nil || len(dismissed) == 0 {
		return findings
	}
	kept := make([]warningFinding, 0, len(findings))
	for _, f := range findings {
		if dismissed[warndismiss.Key(f.File, warndismiss.Fingerprint(f.Text))] {
			continue
		}
		kept = append(kept, f)
	}
	return kept
}

// anchoredWarning maps one LLM finding onto the existing comment-anchoring
// model, reusing blockForLine/rowForLine exactly as an imported GitHub review
// comment does (see comment_import.go). Three outcomes:
//
//   - The file+line pins to an exact row (rowForLine succeeds): a normal,
//     block-scoped warning (Kind "", Gran "line") anchored to that row like
//     any other line comment.
//   - The file+line falls inside a block, but not on a row rowForLine can
//     find — Kind still "", but
//     anchored on the block's own FIRST changed row instead of left
//     unpinned. Unpinned (row -1) used to mean "shown anywhere within this
//     block" for EVERY selection inside it (see commentUnder,
//     RelatedPanel.mjs) — reported bug: the finding kept surfacing under a
//     completely unrelated line/group of the same block. A real row anchor
//     fixes that; BlockWide (true here) tells the frontend to still badge it
//     as being about the whole block, not specifically that first row (see
//     comments.Comment.BlockWide).
//   - The file+line can't be pinned to any block at all — an unchanged/
//     context line outside every block, or a line the model got slightly
//     wrong — becomes a PR-wide warning (Kind "ai_warning") instead of being
//     dropped, so the reviewer still sees it (just without a precise row).
//
// Since the changed-lines guard in runCodeWarningReview, every finding
// reaching here anchors on a line the PR actually changed, so the last two
// outcomes are vangnets rather than the normal route: the second only fires
// when rowForLine cannot map a genuinely changed line onto a diff row, the
// third only when a changed line sits in no scanned block at all. Both are
// kept — narrowing them away would trade a rare, harmless fallback for a
// silently dropped finding.
//
// File is kept in all three cases, as a hint of what the finding is about.
// Every warning is Source "ai" + Local true (never posted to GitHub),
// regardless of whether/how it anchors.
//
// The second return value is the anchored block's id ("" when the finding
// didn't anchor to a block), carried along on warningToCreate.
func anchoredWarning(dataDir string, pr int, blocks []Block, f warningFinding) (CodeCommentInput, string) {
	in := CodeCommentInput{
		PR: pr, File: f.File, Line: f.Line, Author: warningAuthor,
		Body: f.Text, Source: "ai", Local: true, RowStart: -1, RowEnd: -1,
	}
	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)
	b, ok := blockForLine(baseDir, headDir, blocks, f.File, f.Line, "RIGHT")
	if !ok {
		in.Kind = "ai_warning"
		return in, ""
	}
	in.Label = b.Label
	in.Gran = "line"
	if row, ok := rowForLine(baseDir, headDir, b, f.Line, "RIGHT"); ok {
		in.RowStart = row
		in.RowEnd = row
		return in, b.ID()
	}
	// Couldn't pin the exact row — anchor on the block's own first changed
	// row instead of leaving it unpinned, so this finding only ever shows
	// under a navigation unit that actually covers that row (in practice:
	// the block's first group/line), never under every other line of the
	// same block. The label says it's about the whole block, not that row.
	rows, _, _ := blockAlignedRows(baseDir, headDir, b)
	if row, ok := firstChangedRowIndex(rows); ok {
		in.RowStart = row
		in.RowEnd = row
		in.BlockWide = true
	}
	return in, b.ID()
}
