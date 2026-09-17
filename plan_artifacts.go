// plan_artifacts.go — the three planning phases as three files on disk.
//
// Reviewer request, verbatim: "op de planning/tijdens de planning heb je 3
// stages: intent (die kan je zelf genereren vanuit de jira tickt (en hoofdtaak
// als het om een subticket gaat), daarna specs en daarna plan. Kijk wat
// standaard is van claude, maar volgens mij moet je intent.md spec en plan.md
// ofzo maken. check dat even goed. dat mag dan in een losse directory die mag
// worden weggegooid als de pr is gemerged (even gitignored in een dir
// (misschien heb je al een data dir of zoiets)".
//
// The file names are NOT invented here: intent.md → spec.md → plan.md is the
// artifact chain of Anthropic's own AI-Native SDLC Playbook (claude.com /
// Claude Academy), where "each stage ends by writing one to version control
// (including intent.md, spec.md, plan.md, …) and the next stage begins by
// reading it". The playbook keeps intent in an `intent/` folder in the product
// repo; the DIRECTORY here is our own choice instead — data/plans/<KEY>/,
// gitignored — because these files are derived from the plan document and are
// meant to be thrown away once the PR is merged, not committed.
//
// What each file holds, mapped onto what this page already has:
//
//   - intent.md  the ticket itself: problem, outcome, affected users/systems,
//     constraints, open questions — generated from Jira (plus the
//     MAIN TASK when this is a subtask), no Claude call at all.
//   - spec.md    the WHAT, sharpened: the questions the tracker asked and the
//     answers the reviewer picked, plus the branch/scope decisions.
//   - plan.md    the HOW: the task list with its concrete fields (location,
//     conditions, config, migration, …) and the checkbox state.
//
// So the phase a plan is in is not a fourth piece of state to keep in sync —
// it IS the document's own progress (planPhase): a ticket that only loaded has
// intent, one with questions has specs, one with tasks has a plan.
//
// Writing happens inside the planSave Activity (a write, so never outside a
// workflow — .claude/rules/workflows-write-boundary.md). Deliberately NOT as a
// new Activity in the workflow body: the `plan` tracker has a DETERMINISTIC Run
// ID (plan-<KEY>) and tembed matches history positionally, so an extra
// ExecuteActivity would wedge the replay of every existing Execution — the
// trap askBase/loadsContext/startsProgress each needed their own flag for
// (.claude/rules/workflow-determinism.md). Riding along inside an Activity that
// is already called at exactly those moments needs no flag and changes no
// history at all.
//
// Cleaning up (see cleanup.go): the directory carries a .pr marker as soon as
// plan_execute opened its draft PR, so the existing merged-and-old gate purges
// it along with the rest of that PR's data. A directory that never got that
// far — an abandoned plan, a half-finished run — is swept on its own age
// (planArtifactAge), so nothing accumulates that nobody owns.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The three phases, in order. The WORD is what the page shows (never a colour
// on its own, per the colourblind rule) and it is also the phase's own file.
const (
	planPhaseIntent = "intent"
	planPhaseSpecs  = "specs"
	planPhasePlan   = "plan"
)

// planPhaseFile maps a phase onto the file it writes. `specs` writes spec.md
// (singular) — the playbook's own file name; the PHASE keeps the reviewer's own
// plural word.
var planPhaseFile = map[string]string{
	planPhaseIntent: "intent.md",
	planPhaseSpecs:  "spec.md",
	planPhasePlan:   "plan.md",
}

// planPhaseOrder is the fixed order the page renders and this file writes in.
var planPhaseOrder = []string{planPhaseIntent, planPhaseSpecs, planPhasePlan}

// planArtifactsRoot is the gitignored directory holding one subdirectory per
// ticket. Next to data/worktrees/ and data/workflows/, which are gitignored for
// the same reason: derived, per-item, throw-away.
const planArtifactsRoot = "plans"

// planArtifactPRMarker links a plan directory to the pull request its
// plan_execute opened, so cleanup's existing merged-and-old gate can purge it
// with the rest of that PR's data. Deliberately not a .md file: it is
// bookkeeping, not one of the three artifacts. Deliberately not a row in the
// plan document either — that document is held in memory by the tracker and
// rewritten on every answer, so a plan_execute write into it would clobber one
// or the other (the same reasoning plan_api.go records for the exec field).
const planArtifactPRMarker = ".pr"

// planArtifactAge is how long an artifact directory that never got a .pr
// marker is kept. Reviewer's own frame is "weggooien als de pr is gemerged";
// this is the safety net UNDER that rule, for a plan that never reached a PR
// at all (abandoned, or a run that broke halfway) — otherwise those directories
// would be the one thing in data/ nobody ever cleans. 30 days, the same
// retention jiraNotifyRetention uses, and harmless: the files are derived from
// the plan document and are rewritten by the next planSave.
const planArtifactAge = 30 * 24 * time.Hour

// planArtifactDir is the directory of one ticket's artifacts. The key reaches
// the filesystem, so it is validated against the SAME planKeyPattern every
// endpoint uses before it is ever joined onto a path
// (.claude/rules/conventions.md: validate before handing input to anything
// outside Go).
func planArtifactDir(dataDir, key string) (string, error) {
	key = strings.ToUpper(strings.TrimSpace(key))
	if !planKeyPattern.MatchString(key) {
		return "", fmt.Errorf("plan artifacts: invalid issue key %q", key)
	}
	return filepath.Join(dataDir, planArtifactsRoot, key), nil
}

// planPhase reports which of the three stages the planning of this ticket is
// in. Derived, never stored, so it can never drift out of sync with the plan it
// describes and no existing document needs a migration:
//
//   - intent — nothing generated yet: the ticket has been read (and possibly a
//     gate is standing), which is all intent.md needs.
//   - specs  — there is a plan, but the reviewer has not settled every question
//     yet. This is where the reviewer actually spends the planning: picking
//     answers, which regenerates the task list each time.
//   - plan   — every question is answered and there are tasks: the plan is
//     settled and the last action ("Plan uitvoeren") is the honest next step.
//
// Deliberately keyed on the ANSWERS rather than only on "are there tasks":
// planGenerate mode "all" produces questions AND tasks in one call, so a
// content-only rule would jump straight from intent to plan and the middle
// stage would never be visible — the reviewer asked for three stages he moves
// THROUGH while planning, not for two.
func planPhase(doc planDoc) string {
	if len(doc.Questions) == 0 && len(doc.Tasks) == 0 {
		return planPhaseIntent
	}
	if len(doc.Tasks) > 0 && planAllQuestionsAnswered(doc) {
		return planPhasePlan
	}
	return planPhaseSpecs
}

// planAllQuestionsAnswered reports whether every generated question has a
// stored answer. A plan with no questions at all counts as answered — nothing
// is open.
func planAllQuestionsAnswered(doc planDoc) bool {
	for _, q := range doc.Questions {
		if planAnswerFor(doc.Answers, q.ID) == nil {
			return false
		}
	}
	return true
}

// planHasPhaseContent reports whether the document has anything to write for
// this phase — which is what decides that a file exists, deliberately SEPARATE
// from planPhase above. The stage says how far the reviewer is; a file says
// what is known. So an intent-only plan really has one file (three stubs would
// make the stages unreadable on disk), and plan.md appears as the current draft
// as soon as there are tasks, even while the spec is still being sharpened.
func planHasPhaseContent(doc planDoc, phase string) bool {
	switch phase {
	case planPhaseIntent:
		return true
	case planPhaseSpecs:
		return len(doc.Questions) > 0
	case planPhasePlan:
		return len(doc.Tasks) > 0
	}
	return false
}

// writePlanArtifacts writes every file the document has content for and returns
// the file names it wrote, in phase order. A phase not reached yet writes
// nothing (so an intent-only plan has exactly one file, which is what makes the
// three stages visible on disk rather than three stubs).
//
// Each file is written to a temp file in the same directory and renamed into
// place, so a crash or a full disk never leaves a half-written artifact behind
// — the "een half afgebroken run laat geen rommel achter" requirement — and a
// reader never sees a truncated file.
func writePlanArtifacts(dataDir string, doc planDoc) ([]string, error) {
	dir, err := planArtifactDir(dataDir, doc.Key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("plan artifacts: create %s: %w", dir, err)
	}
	bodies := map[string]string{
		planPhaseIntent: renderPlanIntent(doc),
		planPhaseSpecs:  renderPlanSpec(doc),
		planPhasePlan:   renderPlanPlan(doc),
	}
	written := make([]string, 0, len(planPhaseOrder))
	for _, phase := range planPhaseOrder {
		if !planHasPhaseContent(doc, phase) {
			continue
		}
		name := planPhaseFile[phase]
		if err := writeFileAtomic(filepath.Join(dir, name), bodies[phase]); err != nil {
			return written, err
		}
		written = append(written, name)
	}
	return written, nil
}

// writeFileAtomic writes body to path via a temp file + rename. The temp file
// is removed on any failure, so a broken write leaves nothing behind.
func writeFileAtomic(path, body string) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("plan artifacts: temp for %s: %w", path, err)
	}
	name := tmp.Name()
	if _, err := tmp.WriteString(body); err != nil {
		tmp.Close()
		os.Remove(name)
		return fmt.Errorf("plan artifacts: write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("plan artifacts: close %s: %w", path, err)
	}
	// os.CreateTemp makes the file 0600; these are ordinary readable artifacts
	// (the reviewer opens them in an editor), so give them the same mode a
	// plain os.WriteFile would.
	if err := os.Chmod(name, 0o644); err != nil {
		os.Remove(name)
		return fmt.Errorf("plan artifacts: chmod %s: %w", path, err)
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return fmt.Errorf("plan artifacts: rename %s: %w", path, err)
	}
	return nil
}

// writePlanArtifactPR drops the .pr marker so cleanup can link this directory
// to the pull request the plan produced. Best-effort by design: the caller is
// the plan_execute Activity that JUST opened a draft PR, and failing that run
// over a bookkeeping file would be worse than the age sweep catching the
// directory later.
func writePlanArtifactPR(dataDir, key string, pr int) {
	if pr <= 0 {
		return
	}
	dir, err := planArtifactDir(dataDir, key)
	if err != nil {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	_ = writeFileAtomic(filepath.Join(dir, planArtifactPRMarker), strconv.Itoa(pr)+"\n")
}

// planArtifactDirsForPR lists the artifact directories whose .pr marker names
// this pull request — normally exactly one, but a scan rather than a lookup so
// a ticket that was executed twice (or a renamed one) cannot leave a directory
// behind. Sorted, so a caller's own reporting is deterministic.
func planArtifactDirsForPR(dataDir string, pr int) []string {
	if pr <= 0 {
		return nil
	}
	root := filepath.Join(dataDir, planArtifactsRoot)
	entries, err := os.ReadDir(root) // a missing root is fine: nothing to clean
	if err != nil {
		return nil
	}
	var hits []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(root, e.Name(), planArtifactPRMarker))
		if err != nil {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && n == pr {
			hits = append(hits, filepath.Join(root, e.Name()))
		}
	}
	sort.Strings(hits)
	return hits
}

// removePlanArtifactsForPR removes every artifact directory belonging to pr and
// reports how many it removed. Called from purgePR, i.e. only once that PR is
// merged and older than cleanupMergedAge — which is exactly the reviewer's own
// rule ("mag worden weggegooid als de pr is gemerged"), reusing the existing
// gate rather than adding a second cleanup mechanism.
func removePlanArtifactsForPR(dataDir string, pr int) (int, error) {
	n := 0
	for _, dir := range planArtifactDirsForPR(dataDir, pr) {
		if err := os.RemoveAll(dir); err != nil {
			return n, fmt.Errorf("plan artifacts: remove %s: %w", dir, err)
		}
		n++
	}
	return n, nil
}

// sweepPlanArtifacts removes every artifact directory that has NO .pr marker
// (so purgePR will never come for it) and whose newest file predates `before`.
// The age-based half of the cleanup, like sweepTestRunResidue: about the
// directory's OWN age, never about whether a PR is merged.
//
// A directory WITH a marker is deliberately left alone however old it is — its
// PR may still be open, and purgePR owns it either way.
func sweepPlanArtifacts(dataDir string, before time.Time) (int, error) {
	root := filepath.Join(dataDir, planArtifactsRoot)
	entries, err := os.ReadDir(root) // a missing root is fine: nothing to sweep
	if err != nil {
		return 0, nil
	}
	removed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		if _, err := os.Stat(filepath.Join(dir, planArtifactPRMarker)); err == nil {
			continue // owned by a PR, purgePR's business
		}
		newest, ok := newestModTime(dir)
		if !ok || !newest.Before(before) {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return removed, fmt.Errorf("plan artifacts: sweep %s: %w", dir, err)
		}
		removed++
	}
	return removed, nil
}

// newestModTime is the mtime of the most recently touched entry in dir (the
// directory's own mtime when it is empty). "Newest" rather than oldest so a
// plan that is still being sharpened is never swept because one of its three
// files has not changed in a while.
func newestModTime(dir string) (time.Time, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return time.Time{}, false
	}
	var newest time.Time
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	if newest.IsZero() {
		if info, err := os.Stat(dir); err == nil {
			return info.ModTime(), true
		}
		return time.Time{}, false
	}
	return newest, true
}

// planArtifactView is what GET /api/plan reports about the phases — read-only,
// derived from the document plus what is really on disk, so the page never has
// to guess (and a file removed by cleanup stops being claimed the moment it is
// gone).
type planArtifactView struct {
	Dir   string                 `json:"dir"`
	Phase string                 `json:"phase"`
	Files []planArtifactFileView `json:"files"`
}

// planArtifactFileView is one phase's file: its own phase word, its file name,
// its path, and whether it exists yet.
type planArtifactFileView struct {
	Phase  string `json:"phase"`
	File   string `json:"file"`
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
}

// planArtifactsView describes the three phases of one plan. A key the pattern
// refuses (never reachable through the endpoint, which validates first) yields
// no view at all rather than an error: the phases are extra information on a
// page that must keep rendering.
func planArtifactsView(dataDir string, doc planDoc) (planArtifactView, bool) {
	dir, err := planArtifactDir(dataDir, doc.Key)
	if err != nil {
		return planArtifactView{}, false
	}
	out := planArtifactView{Dir: dir, Phase: planPhase(doc)}
	for _, phase := range planPhaseOrder {
		name := planPhaseFile[phase]
		path := filepath.Join(dir, name)
		_, statErr := os.Stat(path)
		out.Files = append(out.Files, planArtifactFileView{
			Phase: phase, File: name, Path: path, Exists: statErr == nil,
		})
	}
	return out, true
}

// ---------------------------------------------------------------------------
// The three renderers. Pure string builders over the document, so every one of
// them is directly unit-testable and none of them can fail.
// ---------------------------------------------------------------------------

// renderPlanIntent is phase 1: the ticket's own intent, generated from Jira —
// "die kan je zelf genereren vanuit de jira tickt (en hoofdtaak als het om een
// subticket gaat)". Sections follow the playbook's own template: problem,
// proposed outcome, affected users and systems, constraints, open questions.
// No Claude call: everything here is already on the document.
func renderPlanIntent(doc planDoc) string {
	// The reviewer's own edit of the "Intentie" field (column 0) replaces the
	// auto-generated document WHOLESALE — never merged section-by-section,
	// which would be brittle against a free-form edit. See planAnswerIntent's
	// own doc comment (plan_workflow.go).
	if strings.TrimSpace(doc.IntentOverride) != "" {
		return doc.IntentOverride
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Intent — %s\n\n", planArtifactTitle(doc))
	writePlanArtifactHeader(&b, doc, planPhaseIntent)

	b.WriteString("## Problem\n\n")
	if d := strings.TrimSpace(doc.Description); d != "" {
		b.WriteString(d + "\n\n")
	} else {
		b.WriteString("_The ticket carries no description._\n\n")
	}

	b.WriteString("## Proposed outcome\n\n")
	fmt.Fprintf(&b, "%s is done when the work described above is implemented and reviewable as a pull request.\n\n", doc.Key)
	// The same WHAT/HOW split the generation prompt opens a subtask with (see
	// writePlanSubtaskFocus, plan_prompt.go), in one line rather than the whole
	// story: a subtask usually has no description at all, so its title is the
	// assignment and everything else here is only means.
	if doc.ParentKey != "" {
		fmt.Fprintf(&b, "Subtask of **%s**: the title above is the assignment — this covers exactly that, never the main task's own work or another subtask's. How to build it comes from the main task, the merged work, the sibling subtasks, the target branch and the related tickets below.\n\n", doc.ParentKey)
	}

	b.WriteString("## Affected users and systems\n\n")
	if doc.ParentKey != "" {
		fmt.Fprintf(&b, "- Part of main task **%s** — %s\n", doc.ParentKey, oneLine(doc.ParentTitle))
	}
	for _, st := range doc.Subtasks {
		fmt.Fprintf(&b, "- Subtask **%s** — %s (%s)\n", st.Key, oneLine(st.Title), orDash(st.Status))
	}
	// The sibling subtasks: whose work this plan builds on, and — status in
	// words, never a colour — whose work it must stay out of.
	if doc.ParentKey != "" {
		for _, sb := range doc.Siblings {
			fmt.Fprintf(&b, "- Sibling subtask **%s** — %s (%s)\n", sb.Key, oneLine(sb.Title), orDash(sb.Status))
		}
	}
	if w := doc.BaseBranchWork; w != nil {
		fmt.Fprintf(&b, "- Already on target branch `%s` (vs `%s`): %s\n", w.Branch, w.Against, oneLine(strings.Join(w.Commits, "; ")))
		if len(w.Files) > 0 {
			fmt.Fprintf(&b, "  - touches %s\n", strings.Join(w.Files, ", "))
		}
	}
	for _, pr := range doc.RelatedPRs {
		fmt.Fprintf(&b, "- Already merged: [#%d %s](%s)", pr.Number, oneLine(pr.Title), pr.URL)
		if len(pr.Files) > 0 {
			fmt.Fprintf(&b, " — touches %s", strings.Join(pr.Files, ", "))
		}
		b.WriteString("\n")
	}
	if doc.ParentKey == "" && len(doc.Subtasks) == 0 && len(doc.RelatedPRs) == 0 && doc.BaseBranchWork == nil {
		b.WriteString("_No related ticket or merged work found._\n")
	}
	b.WriteString("\n")

	// The main task's own description is context the plan is built on, so it
	// belongs in the intent of a subtask rather than only in the prompt.
	if strings.TrimSpace(doc.ParentDescription) != "" {
		fmt.Fprintf(&b, "### Main task %s\n\n%s\n\n", doc.ParentKey, strings.TrimSpace(doc.ParentDescription))
	}

	b.WriteString("## Constraints\n\n")
	wrote := false
	if doc.BaseBranch != "" {
		if doc.Hotfix {
			fmt.Fprintf(&b, "- Hotfix: goes out from `%s`, so keep it small and risk-free — no refactor, no improvements riding along.\n", doc.BaseBranch)
		} else {
			fmt.Fprintf(&b, "- Goes out from `%s`.\n", doc.BaseBranch)
		}
		wrote = true
	}
	if doc.Assignee != "" {
		fmt.Fprintf(&b, "- Assigned to %s.\n", doc.Assignee)
		wrote = true
	}
	if !wrote {
		b.WriteString("_Not decided yet — the branch question has not been answered._\n")
	}
	b.WriteString("\n")

	b.WriteString("## Open questions\n\n")
	if len(doc.Comments)+len(doc.RelatedComments) == 0 {
		b.WriteString("_No Jira comments on this ticket family._\n")
	} else {
		b.WriteString("The comments on this ticket family, newest last — a comment that walks the description back outranks the description:\n\n")
		for _, c := range append(append([]planComment{}, doc.Comments...), doc.RelatedComments...) {
			fmt.Fprintf(&b, "- **%s** (%s%s): %s\n", orDash(c.Author), orDash(c.Created), keySuffix(c.Key), oneLine(c.Body))
		}
	}

	// Related tickets OUTSIDE this one's own family (a Jira link or a bare key
	// mention) — reviewer request: "als het goed is moet PROD-254 dan rekening
	// houden met PROD-216. kan je ervoor zorgen dat je achterhaalt wat de
	// branch is waar PROD-216 al iets in heeft gedaan?" — so plan generation
	// (plan_prompt.go) and a human reader both see what work already exists on
	// a referenced ticket, not just this ticket's own parent/subtasks above.
	if len(doc.Referenced) > 0 {
		b.WriteString("\n## Related tickets\n\n")
		for _, r := range doc.Referenced {
			fmt.Fprintf(&b, "- **%s** (%s) — %s", r.Key, oneLine(orDash(r.Title)), orDash(r.Reason))
			if strings.HasPrefix(r.BranchSource, "pr:") {
				fmt.Fprintf(&b, "; work already on branch `%s` (%s)", r.Branch, r.BranchSource)
			} else if r.Branch != "" {
				fmt.Fprintf(&b, "; possibly on branch `%s` (guessed from %s — unverified)", r.Branch, r.BranchSource)
			} else {
				b.WriteString("; no known branch yet")
			}
			b.WriteString("\n")
		}
	}
	return b.String()
}

// renderPlanSpec is phase 2: the WHAT, as sharpened by the questions the
// tracker asked and the answers the reviewer picked. An unanswered question is
// listed as still open — that is the honest state of the spec, and it is what
// makes the phase readable as a phase.
func renderPlanSpec(doc planDoc) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Spec — %s\n\n", planArtifactTitle(doc))
	writePlanArtifactHeader(&b, doc, planPhaseSpecs)
	b.WriteString("Derived from `intent.md` plus the reviewer's own answers. Requirements only — the steps live in `plan.md`.\n\n")

	b.WriteString("## Decisions\n\n")
	if doc.BaseBranch != "" {
		fmt.Fprintf(&b, "- Base branch: `%s`%s\n", doc.BaseBranch, hotfixSuffix(doc.Hotfix))
	}
	if doc.ParentKey != "" {
		fmt.Fprintf(&b, "- Scope: this subtask only, never the whole main task (%s).\n", doc.ParentKey)
	} else if len(doc.Subtasks) > 0 {
		b.WriteString("- Scope: the main task itself, with its subtasks in view.\n")
	}
	if doc.BaseBranch == "" && doc.ParentKey == "" && len(doc.Subtasks) == 0 {
		b.WriteString("_Nothing decided yet._\n")
	}
	b.WriteString("\n")

	b.WriteString("## Requirements\n\n")
	if len(doc.Questions) == 0 {
		b.WriteString("_No questions generated yet._\n")
		return b.String()
	}
	for i, q := range doc.Questions {
		fmt.Fprintf(&b, "### %d. %s\n\n", i+1, oneLine(q.Question))
		if strings.TrimSpace(q.Why) != "" {
			fmt.Fprintf(&b, "%s\n\n", strings.TrimSpace(q.Why))
		}
		ans := planAnswerFor(doc.Answers, q.ID)
		for _, o := range q.Options {
			mark := "- [ ]"
			if ans != nil && ans.OptionID == o.ID {
				mark = "- [x]"
			}
			fmt.Fprintf(&b, "%s %s", mark, oneLine(o.Label))
			if strings.TrimSpace(o.Detail) != "" {
				fmt.Fprintf(&b, " — %s", oneLine(o.Detail))
			}
			b.WriteString("\n")
		}
		if ans == nil {
			b.WriteString("\n**Still open** — no answer picked.\n")
		} else if strings.TrimSpace(ans.Text) != "" {
			fmt.Fprintf(&b, "\n**The reviewer added:** %s\n", oneLine(ans.Text))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// renderPlanPlan is phase 3: the HOW — the task list with everything the "elke
// if, elke config" rule demands, plus the reviewer's own checkbox and field per
// task. An unchecked task is written down as skipped rather than dropped, so
// the file says the same thing the page does.
func renderPlanPlan(doc planDoc) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Plan — %s\n\n", planArtifactTitle(doc))
	writePlanArtifactHeader(&b, doc, planPhasePlan)
	b.WriteString("Derived from `spec.md`. Only the tasks marked **meenemen** are executed.\n\n")
	if len(doc.Tasks) == 0 {
		b.WriteString("_No tasks generated yet._\n")
		return b.String()
	}
	for i, t := range doc.Tasks {
		st := planTaskStateFor(doc.TaskStates, t.Title)
		mark, word := "[x]", "meenemen"
		if st.Off {
			mark, word = "[ ]", "overslaan"
		}
		fmt.Fprintf(&b, "## %d. %s %s — %s\n\n", i+1, mark, oneLine(t.Title), word)
		if strings.TrimSpace(t.Explanation) != "" {
			fmt.Fprintf(&b, "%s\n\n", strings.TrimSpace(t.Explanation))
		}
		writePlanArtifactDetail(&b, "Location", []string{t.Location})
		writePlanArtifactDetail(&b, "Conditions", t.Conditions)
		writePlanArtifactDetail(&b, "Config", t.Config)
		writePlanArtifactDetail(&b, "Migration", []string{t.Migration})
		writePlanArtifactDetail(&b, "Endpoints", t.Endpoints)
		writePlanArtifactDetail(&b, "Errors", []string{t.Errors})
		writePlanArtifactDetail(&b, "Rollout", []string{t.Rollout})
		writePlanArtifactDetail(&b, "Edge cases", t.EdgeCases)
		writePlanArtifactDetail(&b, "Out of scope", t.OutOfScope)
		if strings.TrimSpace(st.Note) != "" {
			fmt.Fprintf(&b, "- **The reviewer added:** %s\n", oneLine(st.Note))
		}
		for _, blk := range t.Blocks {
			writePlanArtifactBlock(&b, blk, 0)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// writePlanArtifactHeader is the two lines every artifact opens with: which
// ticket, which phase, and when it was written. The phase is spelled out as a
// WORD plus its position in the chain, so "which stage is this" never depends
// on anything visual (the colourblind rule applies to a file too — a reader
// should not have to infer it from the file name alone).
func writePlanArtifactHeader(b *strings.Builder, doc planDoc, phase string) {
	pos := 1
	for i, p := range planPhaseOrder {
		if p == phase {
			pos = i + 1
		}
	}
	fmt.Fprintf(b, "> Phase %d of %d — **%s**. Ticket [%s](%s). Generated by slash from the plan document; do not edit by hand, it is rewritten on every answer.\n\n",
		pos, len(planPhaseOrder), phase, doc.Key, orDash(doc.URL))
	if doc.UpdatedAt != "" {
		fmt.Fprintf(b, "> Last updated %s.\n\n", doc.UpdatedAt)
	}
}

// writePlanArtifactDetail writes one of a task's concrete fields, and nothing
// at all when it is empty — the same rule the page follows (an absent field is
// omitted, never rendered as "n.v.t.").
func writePlanArtifactDetail(b *strings.Builder, label string, values []string) {
	var kept []string
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			kept = append(kept, oneLine(s))
		}
	}
	if len(kept) == 0 {
		return
	}
	fmt.Fprintf(b, "- **%s:** %s\n", label, strings.Join(kept, "; "))
}

// writePlanArtifactBlock writes one example-code block, and its children, at
// the nesting depth it actually has — a nested block's note says why it hangs
// under its parent, exactly as the page renders it.
func writePlanArtifactBlock(b *strings.Builder, blk planBlock, depth int) {
	indent := strings.Repeat("  ", depth)
	fmt.Fprintf(b, "\n%s<details><summary>%s</summary>\n\n", indent, oneLine(firstNonEmpty(blk.Title, blk.Label, "example")))
	if strings.TrimSpace(blk.Note) != "" {
		fmt.Fprintf(b, "%s\n\n", strings.TrimSpace(blk.Note))
	}
	if strings.TrimSpace(blk.Code) != "" {
		fmt.Fprintf(b, "```%s\n%s\n```\n", firstNonEmpty(blk.Lang, "php"), strings.TrimRight(blk.Code, "\n"))
	}
	for _, child := range blk.Children {
		writePlanArtifactBlock(b, child, depth+1)
	}
	fmt.Fprintf(b, "\n%s</details>\n", indent)
}

// planAnswerFor finds the reviewer's stored answer to one question, or nil.
func planAnswerFor(list []planAnswer, questionID string) *planAnswer {
	for i := range list {
		if list[i].QuestionID == questionID {
			return &list[i]
		}
	}
	return nil
}

// planArtifactTitle is the heading of every artifact: the key plus the title,
// or just the key for a ticket that could not be read.
func planArtifactTitle(doc planDoc) string {
	if t := strings.TrimSpace(doc.Title); t != "" {
		return doc.Key + " " + oneLine(t)
	}
	return doc.Key
}

func hotfixSuffix(hotfix bool) string {
	if hotfix {
		return " (hotfix)"
	}
	return ""
}

func keySuffix(key string) string {
	if strings.TrimSpace(key) == "" {
		return ""
	}
	return ", on " + key
}

// oneLine collapses a value onto one line so it can never break the Markdown
// list/table it sits in.
func oneLine(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "\n", " ")), " ")
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
