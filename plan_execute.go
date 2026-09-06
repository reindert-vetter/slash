// plan_execute.go — "voer het plan uit": the LAST action of the index on the
// /plan/<JIRA-KEY> page. One agentic Claude run turns the stored plan document
// (the ticket, the answers the reviewer picked, the task list) into real code
// on a fresh branch, which is then pushed and opened as a DRAFT pull request.
//
// It closes the chain the reviewer asked for: todo → planning → needs your
// review → draft PR. Everything before this file sharpens the plan; this is the
// one step that acts on it.
//
// Modelled on test_run.go/comment_batch.go — read those headers first; this one
// only calls out where a plan execution differs:
//
//  1. NO PR exists yet, but the reviewer's own WERKMAP is used all the same —
//     the same standing local checkout a review-tree write turn edits
//     (chat_checkout.go), resolved through that very same selection ladder
//     (settings.json's chatCheckoutDirs, then the bounded home scan, matched on
//     the repo slug). Reviewer decision: "voor het uitvoeren moet je een
//     werkmap gebruiken net als bij de tree" — this workflow used to build its
//     own disposable git worktree at data/worktrees/plan-<KEY> instead, which
//     put the plan's work somewhere the reviewer never looks. Since the plan's
//     branch does not exist anywhere yet, the ladder is asked for a checkout
//     that is on the BASE branch (or on some other branch already merged into
//     it, i.e. genuinely free), and the plan branch is created there with
//     `git checkout -B <branch> origin/<base>`. See resolvePlanWorkDir.
//  2. ALWAYS the primary repo (plug-and-pay/plug-and-pay, base develop). A plan
//     hangs off a Jira ticket, which carries no repo, and the page offers no
//     repo choice — an explicit reviewer decision, not an oversight.
//  3. Claude EDITS, Go COMMITS. The run gets Read/Grep/Glob/Edit/Bash (the same
//     shell carve-out a chat turn has, see
//     .claude/rules/workflows-write-boundary.md), but the commit, the push and
//     `gh pr create --draft` are done here, in Go — so "did it actually commit?"
//     is never a question, and the PR's URL is a real, parsed result rather
//     than something scraped out of the model's prose.
//  4. TWO Activities around the agentic one: preparing/committing and opening
//     the PR are split, so a failed push or a `gh` hiccup can be retried
//     without paying for the whole Claude run again. The resolved werkmap
//     travels between them on the Activity's own recorded result/input
//     (planExecuteResult.Dir -> planExecutePRArg.Dir), so the second one never
//     re-runs the ladder and can never land on a different directory than the
//     one Claude actually edited.
//  5. NO deterministic Run ID (unlike the `plan` tracker itself). A plan may be
//     executed more than once — a second attempt is simply a second run, and
//     RunsForPlan finds every one of them by the `key` on their input, so they
//     all show up in the page's own "Taken" card for free. A second run while
//     one is still going is refused with 409 (handlePlanExecuteStart), the same
//     precedent handleTestRunStart sets.
//
// See .claude/docs/plan-page.md.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/reindert-vetter/tembed"

	"slash/modules/claude"
	"slash/modules/langpref"
)

const (
	// WorkflowPlanExecute is the Workflow Type behind the index's last action.
	WorkflowPlanExecute = "plan_execute"
)

// planExecuteMaxTasks/planExecuteMaxBlockLines bound what of the plan document
// reaches the prompt: the document is model-authored and could in principle be
// large, and the prompt must stay a bounded function of it.
const (
	planExecuteMaxTasks       = maxPlanTasks
	planExecuteMaxBlockLines  = 30
	planExecuteMaxNoteLen     = 400
	planExecuteMaxBranchSlug  = 40
	planExecuteMaxBodyEntries = 12
)

// PlanExecuteInput starts a plan_execute Execution. Only the ticket key: the
// repo is always the primary one (see the file header, point 2).
type PlanExecuteInput struct {
	Key string `json:"key"`
}

// planExecuteAgentArg is what the agent Activity gets — the whole document plus
// the branch to work on, so the Activity is a pure function of its recorded
// input.
type planExecuteAgentArg struct {
	Doc    planDoc `json:"doc"`
	Branch string  `json:"branch"`
}

// planExecutePRArg is what the PR Activity gets: the branch that now carries a
// commit, plus the title/body facts it needs.
type planExecutePRArg struct {
	Key    string   `json:"key"`
	Title  string   `json:"title"`
	Branch string   `json:"branch"`
	URL    string   `json:"url,omitempty"`
	Tasks  []string `json:"tasks,omitempty"`
	// Dir is the werkmap the agent Activity actually used — carried over
	// rather than re-resolved, see the file header (point 4).
	Dir string `json:"dir,omitempty"`
}

// planExecuteResult is what the workflow records — deliberately bounded (a
// branch, a PR reference, one short note), never the run's transcript.
type planExecuteResult struct {
	Branch string `json:"branch,omitempty"`
	// Dir is the werkmap this attempt ran in (chat_checkout.go's own selection
	// ladder), so the page can say WHERE the plan was implemented.
	Dir      string `json:"dir,omitempty"`
	Commit   string `json:"commit,omitempty"`
	PRURL    string `json:"prUrl,omitempty"`
	PRNumber int    `json:"prNumber,omitempty"`
	// Changed reports whether the agentic run left anything to commit at all.
	Changed bool `json:"changed"`
	// Note is a short, human reason things ended the way they did (nothing
	// changed, claude unavailable, push refused). Never an error wall: the page
	// shows it as a line under the action row.
	Note string `json:"note,omitempty"`
}

// planExecuteWorkflow: load the plan, let Claude implement it on a fresh
// branch, then open the draft PR. Three Activities in a fixed order, no
// branching on anything but their own recorded results — trivially
// deterministic (.claude/rules/workflow-determinism.md).
func planExecuteWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in PlanExecuteInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	var doc planDoc
	if err := w.ExecuteActivity("planExecuteLoad", in, &doc); err != nil {
		return nil, fmt.Errorf("plan execute: load plan: %w", err)
	}
	if len(doc.Tasks) == 0 {
		return json.Marshal(planExecuteResult{Note: "Er staat nog geen takenlijst in dit plan."})
	}
	branch := planBranchName(doc.Key, doc.Title)
	var res planExecuteResult
	if err := w.ExecuteActivity("planExecuteAgent", planExecuteAgentArg{Doc: doc, Branch: branch}, &res); err != nil {
		return nil, fmt.Errorf("plan execute: agent: %w", err)
	}
	if !res.Changed || res.Commit == "" {
		return json.Marshal(res)
	}
	var pr planExecuteResult
	arg := planExecutePRArg{Key: doc.Key, Title: doc.Title, Branch: branch, URL: doc.URL, Tasks: planTaskTitles(doc), Dir: res.Dir}
	if err := w.ExecuteActivity("planExecuteOpenPR", arg, &pr); err != nil {
		return nil, fmt.Errorf("plan execute: open pr: %w", err)
	}
	res.PRURL, res.PRNumber = pr.PRURL, pr.PRNumber
	if pr.Note != "" {
		res.Note = pr.Note
	}
	return json.Marshal(res)
}

// planTaskTitles is the bounded list of task titles that goes into the PR body.
func planTaskTitles(doc planDoc) []string {
	out := make([]string, 0, len(doc.Tasks))
	for _, t := range doc.Tasks {
		if len(out) >= planExecuteMaxBodyEntries {
			break
		}
		out = append(out, t.Title)
	}
	return out
}

// StartPlanExecute launches one plan_execute Execution. Starting an Execution
// is the sanctioned write path; StartWorkflowDeferLow so the HTTP request
// returns immediately instead of holding the browser for the whole agentic run
// (same as StartTestRun/StartCommentBatch).
func (m *TaskManager) StartPlanExecute(key string) (string, error) {
	if m == nil || m.engine == nil {
		return "", fmt.Errorf("no engine")
	}
	key = strings.ToUpper(strings.TrimSpace(key))
	if !planKeyPattern.MatchString(key) {
		return "", fmt.Errorf("plan execute: invalid issue key %q", key)
	}
	return m.engine.StartWorkflowDeferLow(WorkflowPlanExecute, PlanExecuteInput{Key: key})
}

// PlanExecView is the read model behind GET /api/plan's `exec` field: the
// NEWEST plan_execute run of one ticket, plus its result once it has one.
type PlanExecView struct {
	RunID    string `json:"runId"`
	Status   string `json:"status"`
	Branch   string `json:"branch,omitempty"`
	Dir      string `json:"dir,omitempty"`
	PRURL    string `json:"prUrl,omitempty"`
	PRNumber int    `json:"prNumber,omitempty"`
	Note     string `json:"note,omitempty"`
}

// PlanExecution reads the newest plan_execute run for key (read-only). The
// result lives in the workflow's own history — no second table, and no write
// into the plan document, which the `plan` tracker holds in memory and rewrites
// on every answer (a shared row would clobber one or the other).
func (m *TaskManager) PlanExecution(key string) (PlanExecView, bool) {
	var out PlanExecView
	if m == nil || m.engine == nil {
		return out, false
	}
	runs, err := m.engine.Runs()
	if err != nil {
		return out, false
	}
	found := false
	var newest tembed.RunRecord
	for _, r := range runs {
		if r.Workflow != WorkflowPlanExecute {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input PlanExecuteInput
		if json.Unmarshal(in, &input) != nil || !strings.EqualFold(input.Key, key) {
			continue
		}
		if !found || r.CreatedAt.After(newest.CreatedAt) {
			newest, found = r, true
		}
	}
	if !found {
		return out, false
	}
	out = PlanExecView{RunID: newest.ID, Status: newest.Status}
	var res planExecuteResult
	if m.engine.Result(newest.ID, &res) == nil {
		out.Branch, out.Dir, out.PRURL, out.PRNumber, out.Note = res.Branch, res.Dir, res.PRURL, res.PRNumber, res.Note
	}
	return out, true
}

// PlanExecuteRunning reports whether a plan_execute run for this ticket is
// still going — the 409 guard of the start endpoint.
func (m *TaskManager) PlanExecuteRunning(key string) bool {
	view, ok := m.PlanExecution(key)
	return ok && view.Status == tembed.StatusRunning
}

// planBranchSlugRe strips everything a git ref may not carry. The branch name
// reaches `git`/`gh` as an argument, so it is built from a strict allow-list
// rather than merely escaped (.claude/rules/conventions.md, "always validate
// input before handing it to a subprocess").
var planBranchSlugRe = regexp.MustCompile(`[^a-z0-9]+`)

// planBranchName is the branch a plan is implemented on: the ticket key plus a
// slug of its title, e.g. "PAYM-813-add-refund-endpoint". Lowercased key first
// so the session-rename hook (and a human reading `git branch`) still finds the
// Jira key at the front. A title that slugs to nothing yields the bare key.
func planBranchName(key, title string) string {
	base := strings.ToLower(strings.TrimSpace(key))
	base = planBranchSlugRe.ReplaceAllString(base, "-")
	base = strings.Trim(base, "-")
	if base == "" {
		base = "plan"
	}
	slug := strings.ToLower(strings.TrimSpace(title))
	slug = planBranchSlugRe.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > planExecuteMaxBranchSlug {
		slug = strings.Trim(slug[:planExecuteMaxBranchSlug], "-")
	}
	if slug == "" {
		return base
	}
	return base + "-" + slug
}

// resolvePlanWorkDir picks the WERKMAP a plan is implemented in: one of the
// reviewer's own standing local checkouts of the primary repo, through the
// exact same selection ladder a review-tree write turn uses
// (listCheckoutCandidates, chat_checkout.go) — settings.json's
// chatCheckoutDirs first, the bounded home scan only when that yields
// nothing, matched on the repo slug (never a fork).
//
// Two deliberate differences from the tree's own use of that ladder, both
// forced by "there is no PR yet":
//
//   - headRef is the BASE branch. The plan's own branch does not exist
//     anywhere at this point, so "already on the target branch" cannot mean
//     anything; asking for the base branch instead makes a checkout sitting on
//     develop count as OnTargetBranch (and thus win via prioritizeOnTargetBranch),
//     while a checkout on some other, already-merged branch still qualifies as
//     MergedIntoBase. Both are exactly the ladder's own notion of "genuinely
//     free, not someone's unfinished work".
//   - The choice is AUTOMATIC, never put to the reviewer. The tree asks
//     (checkoutStageChooseDirectory, src/workDirOverlay.mjs) because a chat
//     turn has a conversation to ask in; the plan page deliberately has no
//     such overlay — see the accepted gaps in .claude/docs/plan-page.md. So
//     the first usable candidate wins, deterministically: registry before home
//     scan, on-the-base-branch before merely-merged.
//
// A DIRTY candidate is skipped rather than asked about: this run is about to
// put a fresh branch in that directory, and dragging the reviewer's own
// uncommitted work onto it (or into the draft PR's commit) is never a guess
// worth making. A directory another PR's chat already claims is held back the
// same way the tree holds it back (checkoutDirClaimsByOtherPRs; pr 0 is never
// a real PR number, so every claim counts as "someone else's").
//
// Returns ("", note) when there is nothing usable — a reviewer-facing sentence
// naming what was actually in the way, never a fallback to a disposable
// worktree.
func resolvePlanWorkDir(ctx context.Context, dataDir string) (dir string, note string) {
	slug := repoSlugFor("")
	base := baseBranchFor("")
	hold := checkoutHoldback{Claimed: checkoutDirClaimsByOtherPRs("", 0)}
	candidates, diag := listCheckoutCandidates(ctx, dataDir, slug, base, base, hold)

	var usable []checkoutCandidate
	var dirty []string
	for _, c := range candidates {
		if c.Dirty {
			dirty = append(dirty, c.Dir)
			continue
		}
		usable = append(usable, c)
	}
	if usable = prioritizeOnTargetBranch(usable); len(usable) > 0 {
		return usable[0].Dir, ""
	}
	if len(dirty) > 0 {
		return "", fmt.Sprintf("De werkmap(pen) van deze repo (%s) hebben nog niet-vastgelegde wijzigingen; die laat ik met rust. Commit of stash ze, of voeg een vrije map toe aan chatCheckoutDirs in settings.json.",
			strings.Join(dirty, ", "))
	}
	if reason := diag.reason(); reason != "" {
		return "", reason
	}
	return "", "Ik vond geen lokale werkmap van " + slug + ". Voeg er een toe aan chatCheckoutDirs in settings.json, of clone de repo lokaal."
}

// registerPlanExecuteActivities wires the three Activities. Called from
// registerWorkflows in workflows.go.
func (m *TaskManager) registerPlanExecuteActivities(engine *tembed.Engine) {
	// Activity: read the stored plan document (a DB read, hence an Activity).
	engine.RegisterActivity("planExecuteLoad", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PlanExecuteInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		doc, _ := m.PlanDoc(ctx, strings.ToUpper(strings.TrimSpace(arg.Key)))
		if doc.Key == "" {
			doc.Key = strings.ToUpper(strings.TrimSpace(arg.Key))
		}
		return json.Marshal(doc)
	})

	// Activity: the one agentic run — prepare the branch/worktree, let Claude
	// implement the plan in it, then commit whatever it changed. Never returns
	// an error for a "the world said no" outcome (no claude, nothing changed):
	// those become a recorded note, exactly like planLoadIssue's own failure
	// handling, so the reviewer sees a reason instead of a failed tracker.
	engine.RegisterActivity("planExecuteAgent", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg planExecuteAgentArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return json.Marshal(m.runPlanExecuteAgent(ctx, arg))
	})

	// Activity: push the branch and open the DRAFT pull request (gh, a real
	// external write — workflow-driven, per the write-boundary rule).
	engine.RegisterActivity("planExecuteOpenPR", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg planExecutePRArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		return json.Marshal(m.runPlanExecuteOpenPR(ctx, arg))
	})
}

// runPlanExecuteAgent is the planExecuteAgent Activity's body — see its
// registration above.
func (m *TaskManager) runPlanExecuteAgent(ctx context.Context, arg planExecuteAgentArg) planExecuteResult {
	res := planExecuteResult{Branch: arg.Branch}
	if m.claude == nil {
		res.Note = "Claude is niet beschikbaar, dus er is niets uitgevoerd."
		return res
	}
	base := baseBranchFor("")
	dir, note := resolvePlanWorkDir(ctx, m.dataDir)
	if dir == "" {
		m.logf("plan execute %s: no werkmap: %s", arg.Doc.Key, note)
		res.Note = note
		return res
	}
	res.Dir = dir

	// One writer per checkout, exactly like the tree: a review-tree write
	// turn, its landing and the werkmap overlay's own actions all take this
	// same per-directory slot (chat_write_gate.go / checkoutWriteSlotKey), so
	// a plan execution can never run its `checkout -B` into a directory
	// another turn is mid-edit in.
	release := acquireWriteTurnSlot(ctx, "dir:"+dir, func() {
		m.logf("plan execute %s: waiting for the werkmap %s", arg.Doc.Key, dir)
	})
	defer release()

	// Re-check after the wait: the turn we queued behind may have left work
	// behind, and the reviewer's uncommitted work is never ours to move.
	if dirty, err := checkoutIsDirty(ctx, dir); err != nil || dirty {
		res.Note = "De werkmap " + dir + " heeft nog niet-vastgelegde wijzigingen; die laat ik met rust."
		return res
	}
	if _, err := runGitIn(ctx, dir, "fetch", "origin", base); err != nil {
		m.logf("plan execute %s: fetch %s: %v", arg.Doc.Key, base, err)
		res.Note = "Kon de basisbranch niet ophalen: " + err.Error()
		return res
	}
	// The branch is created IN the reviewer's own checkout and deliberately
	// left there afterwards: once the draft PR exists, the tree's own ladder
	// finds this very directory already on that PR's head branch, so reviewing
	// what was just planned continues in the same werkmap.
	if _, err := runGitIn(ctx, dir, "checkout", "-B", arg.Branch, "origin/"+base); err != nil {
		m.logf("plan execute %s: checkout -B: %v", arg.Doc.Key, err)
		res.Note = "Kon in werkmap " + dir + " geen branch " + arg.Branch + " klaarzetten."
		return res
	}

	// The shell carve-out a chat turn already has: Claude may run git/tests
	// itself while implementing (see .claude/rules/workflows-write-boundary.md,
	// "the Claude chat turn may act through a shell").
	if _, err := m.claude.Run(ctx, claude.RunRequest{
		Model:   claude.ModelOpus,
		Prompt:  planExecutePrompt(arg.Doc) + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
		WorkDir: dir,
		Tools:   []string{"Read", "Grep", "Glob", "Edit", "Bash"},
	}); err != nil {
		m.logf("plan execute %s: claude: %v", arg.Doc.Key, err)
		res.Note = "Claude kon het plan niet uitvoeren: " + err.Error()
		return res
	}

	// Go commits, not Claude (see the file header, point 3).
	status, err := runGitIn(ctx, dir, "status", "--porcelain")
	if err != nil {
		res.Note = "Kon de wijzigingen niet bekijken: " + err.Error()
		return res
	}
	if strings.TrimSpace(string(status)) == "" {
		// Claude may legitimately have committed by itself through Bash.
		if sha, ok := planBranchAheadOfBase(ctx, dir, base); ok {
			res.Changed, res.Commit = true, sha
			return res
		}
		res.Note = "Claude heeft geen wijzigingen achtergelaten."
		return res
	}
	if _, err := runGitIn(ctx, dir, "add", "-A"); err != nil {
		res.Note = "Kon de wijzigingen niet klaarzetten: " + err.Error()
		return res
	}
	if _, err := runGitIn(ctx, dir, "commit", "-m", planCommitMessage(arg.Doc)); err != nil {
		m.logf("plan execute %s: commit: %v", arg.Doc.Key, err)
		res.Note = "Kon niet committen: " + err.Error()
		return res
	}
	sha, err := runGitIn(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		res.Note = "Kon de commit niet lezen: " + err.Error()
		return res
	}
	res.Changed, res.Commit = true, strings.TrimSpace(string(sha))
	return res
}

// planBranchAheadOfBase reports the worktree's HEAD when it already carries a
// commit that origin/<base> does not — the case where Claude committed through
// its own Bash tool, which leaves a clean `git status` but a real commit.
func planBranchAheadOfBase(ctx context.Context, dir, base string) (string, bool) {
	out, err := runGitIn(ctx, dir, "rev-list", "--count", "origin/"+base+"..HEAD")
	if err != nil {
		return "", false
	}
	n, convErr := strconv.Atoi(strings.TrimSpace(string(out)))
	if convErr != nil || n == 0 {
		return "", false
	}
	sha, err := runGitIn(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(sha)), true
}

// runPlanExecuteOpenPR is the planExecuteOpenPR Activity's body: push the
// branch and open the draft PR.
func (m *TaskManager) runPlanExecuteOpenPR(ctx context.Context, arg planExecutePRArg) planExecuteResult {
	res := planExecuteResult{Branch: arg.Branch, Dir: arg.Dir, Changed: true}
	dir := arg.Dir
	if dir == "" {
		res.Note = "De werkmap van deze uitvoering is niet meer bekend; voer het plan opnieuw uit."
		return res
	}
	// Same per-checkout slot as the agent Activity above — the push reads the
	// directory's own branch state.
	release := acquireWriteTurnSlot(ctx, "dir:"+dir, nil)
	defer release()
	if _, err := runGitIn(ctx, dir, "push", "-u", "origin", arg.Branch); err != nil {
		m.logf("plan execute %s: push: %v", arg.Key, err)
		res.Note = "Kon de branch niet pushen: " + err.Error()
		return res
	}
	out, err := runPlanGH(ctx, "pr", "create",
		"--repo", repoSlugFor(""),
		"--draft",
		"--base", baseBranchFor(""),
		"--head", arg.Branch,
		"--title", planPRTitle(arg),
		"--body", planPRBody(arg))
	if err != nil {
		m.logf("plan execute %s: gh pr create: %v", arg.Key, err)
		res.Note = "Kon de draft-PR niet aanmaken: " + err.Error()
		return res
	}
	res.PRURL = planFirstPRURL(string(out))
	res.PRNumber = planPRNumberFromURL(res.PRURL)
	if res.PRURL == "" {
		res.Note = "De draft-PR is aangemaakt, maar het adres kwam niet terug."
	}
	return res
}

// runPlanGH runs one `gh` command with separate args (never a shell string)
// and returns its stdout, folding gh's own stderr into the error so a failure
// says what GitHub actually refused. Its own small helper rather than a shared
// one: every other gh call site in this codebase builds its own exec.Command
// the same way (gh.go, inbox.go, modules/github).
func runPlanGH(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "gh", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return out, fmt.Errorf("gh %s: %w: %s", strings.Join(args[:2], " "), err, msg)
		}
		return out, fmt.Errorf("gh %s: %w", strings.Join(args[:2], " "), err)
	}
	return out, nil
}

// planPRURLRe finds the PR URL `gh pr create` prints on stdout.
var planPRURLRe = regexp.MustCompile(`https://github\.com/[^\s]+/pull/\d+`)

func planFirstPRURL(out string) string { return planPRURLRe.FindString(out) }

// planPRNumberFromURL reads the number off the URL `gh` printed.
func planPRNumberFromURL(url string) int {
	i := strings.LastIndex(url, "/")
	if i < 0 {
		return 0
	}
	n, err := strconv.Atoi(url[i+1:])
	if err != nil {
		return 0
	}
	return n
}

// planPRTitle/planPRBody/planCommitMessage: English, per the repo convention
// that code and commits are English (the ticket's own title is whatever Jira
// carries).
func planPRTitle(arg planExecutePRArg) string {
	if strings.TrimSpace(arg.Title) == "" {
		return arg.Key
	}
	return arg.Key + " " + strings.TrimSpace(arg.Title)
}

func planPRBody(arg planExecutePRArg) string {
	var b strings.Builder
	b.WriteString("Drafted from the plan on /plan/" + arg.Key + ".\n\n")
	if arg.URL != "" {
		b.WriteString("Jira: " + arg.URL + "\n\n")
	}
	if len(arg.Tasks) > 0 {
		b.WriteString("Plan:\n")
		for _, t := range arg.Tasks {
			b.WriteString("- " + t + "\n")
		}
	}
	return b.String()
}

func planCommitMessage(doc planDoc) string {
	title := strings.TrimSpace(doc.Title)
	if title == "" {
		return doc.Key + " implement the plan"
	}
	return doc.Key + " " + title
}

// planExecutePrompt is the instruction the agentic run gets: the ticket, the
// answers the reviewer fixed, and every task with its explanation and example
// code. Bounded (see the planExecuteMax* constants) so the prompt stays a
// bounded function of a model-authored document.
func planExecutePrompt(doc planDoc) string {
	var b strings.Builder
	b.WriteString("Je voert een uitgewerkt plan uit in deze repository. Je werkt in de werkmap van de reviewer, die al op een verse branch vanaf de basisbranch is gezet.\n\n")
	fmt.Fprintf(&b, "TICKET %s: %s\n\n", doc.Key, strings.TrimSpace(doc.Title))
	desc := strings.TrimSpace(doc.Description)
	if len(desc) > 4000 {
		desc = desc[:4000] + "\n…(afgekapt)"
	}
	if desc != "" {
		b.WriteString("OMSCHRIJVING:\n" + desc + "\n\n")
	}
	if len(doc.Answers) > 0 {
		b.WriteString("VASTSTAANDE KEUZES (de reviewer heeft deze al gemaakt, wijk hier niet van af):\n")
		for _, a := range doc.Answers {
			q, opt := planLookupAnswer(doc, a)
			fmt.Fprintf(&b, "- %s → %s", q, opt)
			if a.Text != "" {
				fmt.Fprintf(&b, " (toelichting: %s)", a.Text)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("HET PLAN, in uitvoervolgorde:\n")
	for i, task := range doc.Tasks {
		if i >= planExecuteMaxTasks {
			break
		}
		fmt.Fprintf(&b, "\n%d. %s\n", i+1, task.Title)
		if note := truncatePlanText(task.Explanation, planExecuteMaxNoteLen); note != "" {
			b.WriteString("   " + note + "\n")
		}
		for _, blk := range task.Blocks {
			writePlanPromptBlock(&b, blk, 1)
		}
	}
	b.WriteString("\nRegels:\n")
	b.WriteString("- De voorbeeldcode in het plan is een SCHETS, geen kopieerwerk: pas hem aan de echte code in deze repository aan.\n")
	b.WriteString("- Volg de conventies van deze repository (lees CLAUDE.md en de bestaande code in de buurt van wat je aanpast).\n")
	b.WriteString("- Werk zo ver als je verantwoord komt. Kom je iets tegen dat echt niet kan zonder een nieuwe beslissing, doe dan de rest wel en laat dat punt staan.\n")
	b.WriteString("- Je hoeft NIET te committen of te pushen: dat gebeurt automatisch nadat je klaar bent.\n")
	b.WriteString("- Code, identifiers en commentaar in het Engels.\n")
	return b.String()
}

// writePlanPromptBlock renders one example block (and its children) into the
// prompt, indented per nesting level and trimmed to a bounded number of lines.
func writePlanPromptBlock(b *strings.Builder, blk planBlock, depth int) {
	indent := strings.Repeat("   ", depth)
	fmt.Fprintf(b, "%s- %s", indent, blk.Title)
	if blk.Label != "" {
		fmt.Fprintf(b, " (%s)", blk.Label)
	}
	b.WriteString("\n")
	if note := truncatePlanText(blk.Note, planExecuteMaxNoteLen); note != "" {
		b.WriteString(indent + "  " + note + "\n")
	}
	if code := trimPlanCode(blk.Code); code != "" {
		lang := blk.Lang
		if lang == "" {
			lang = "php"
		}
		b.WriteString(indent + "  ```" + lang + "\n" + code + "\n" + indent + "  ```\n")
	}
	for _, kid := range blk.Children {
		writePlanPromptBlock(b, kid, depth+1)
	}
}

// trimPlanCode caps one block's code at planExecuteMaxBlockLines lines.
func trimPlanCode(code string) string {
	code = strings.TrimRight(code, "\n")
	if code == "" {
		return ""
	}
	lines := strings.Split(code, "\n")
	if len(lines) <= planExecuteMaxBlockLines {
		return code
	}
	return strings.Join(lines[:planExecuteMaxBlockLines], "\n") + "\n…"
}

func truncatePlanText(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
