// qa_run_checkpoint.go — resuming a QA run per step instead of from scratch.
//
// Reviewer request: *"ook wil ik dat het per stap weer verder gaat waar het
// gebleven was voor de volgende keer"*. A qa_run is one long Activity; when
// the server restarts mid-run, tembed's Recover re-executes that Activity from
// the top (.claude/docs/tembed-workflows.md). Without this file that meant the
// whole QA test again (PR 14561: 22 minutes).
//
// The mechanism, all INSIDE the runQARun Activity (so the workflow body and
// its history are untouched — .claude/rules/workflow-determinism.md):
//
//   - The progress sink writes <runDir>/checkpoint.json after every step
//     marker: the plan plus every todo with its state, result, one-line
//     finding and the screenshots taken while it ran. A write by the Activity,
//     the same category as the screenshots Playwright writes into that dir
//     (.claude/rules/workflows-write-boundary.md) — never the source of truth
//     for the report, which stays the run's recorded result.
//   - The checkout guard's snapshot is saved there too
//     (checkout-snapshot.json): a hard kill never runs the deferred restore,
//     and a fresh snapshot on resume would mistake the interrupted part's
//     leftovers for the reviewer's own work.
//   - On (re)start, qaResumeFor finds a checkpoint with finished steps: the
//     run's own (a restart: same runID, same dir) or, for a new round right
//     after a round WITHOUT a report (cancelled, failed, killed), the previous
//     round's (its screenshots are copied over). The prompt then lists what is
//     done and Claude continues with the rest.
//
// Prompt-based on purpose, not `claude --resume`: a resumed session drags the
// whole (~200k token) context along, which makes every later turn slower, its
// last tool call was cut off mid-way, and the isolated Playwright browser
// (login, tabs) is gone after a restart anyway.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	qaCheckpointFile = "checkpoint.json"
	qaSnapshotFile   = "checkout-snapshot.json"
	qaMaxStepImages  = 20
)

// qaCheckpoint is the durable per-step state of one run.
type qaCheckpoint struct {
	RunID string   `json:"runId"`
	Head  string   `json:"head,omitempty"` // the checkout's HEAD the steps ran against
	Plan  string   `json:"plan,omitempty"`
	Todos []qaTodo `json:"todos"`
}

// qaResume is what a run continues from.
type qaResume struct {
	FromRound int // 0 = the same run (a restart); else the earlier round
	PrevHead  string
	Head      string
	Plan      string
	Todos     []qaTodo
}

func saveQACheckpoint(runDir string, cp qaCheckpoint) error {
	b, err := json.MarshalIndent(cp, "", " ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(runDir, qaCheckpointFile), string(b))
}

func loadQACheckpoint(runDir string) (*qaCheckpoint, bool) {
	b, err := os.ReadFile(filepath.Join(runDir, qaCheckpointFile))
	if err != nil {
		return nil, false
	}
	var cp qaCheckpoint
	if json.Unmarshal(b, &cp) != nil {
		return nil, false
	}
	return &cp, true
}

func saveQASnapshot(runDir string, snap *qaCheckoutSnapshot) error {
	b, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(runDir, qaSnapshotFile), string(b))
}

func loadQASnapshot(runDir string) (*qaCheckoutSnapshot, bool) {
	b, err := os.ReadFile(filepath.Join(runDir, qaSnapshotFile))
	if err != nil {
		return nil, false
	}
	var snap qaCheckoutSnapshot
	if json.Unmarshal(b, &snap) != nil || snap.Head == "" {
		return nil, false
	}
	return &snap, true
}

// qaDoneCount counts the finished steps of a checkpoint.
func qaDoneCount(todos []qaTodo) int {
	n := 0
	for _, t := range todos {
		if t.State == "done" {
			n++
		}
	}
	return n
}

// qaResumeFor decides what this run continues from: its own checkpoint (a
// restart), else — only when the previous round left no report — that
// round's. prevHasReport says whether the previous round recorded a report.
// A checkpoint without a finished step is nothing to resume.
func qaResumeFor(dataDir string, arg qaRunArg, runDir, head string, prevHasReport bool) *qaResume {
	if cp, ok := loadQACheckpoint(runDir); ok && qaDoneCount(cp.Todos) > 0 {
		return &qaResume{PrevHead: cp.Head, Head: head, Plan: cp.Plan, Todos: cp.Todos}
	}
	if arg.PrevRunID == "" || prevHasReport || !qaRunIDRe.MatchString(arg.PrevRunID) {
		return nil
	}
	prevDir := qaRunDir(dataDir, arg.PR, arg.PrevRunID)
	cp, ok := loadQACheckpoint(prevDir)
	if !ok || qaDoneCount(cp.Todos) == 0 {
		return nil
	}
	// The earlier round's screenshots move along, so the report can show them
	// (the sanitizer only accepts files in this run's own dir).
	for _, t := range cp.Todos {
		for _, name := range t.Images {
			if qaImageFileRe.MatchString(name) {
				_ = copyQAFile(filepath.Join(prevDir, name), filepath.Join(runDir, name))
			}
		}
	}
	return &qaResume{FromRound: arg.Round - 1, PrevHead: cp.Head, Head: head, Plan: cp.Plan, Todos: cp.Todos}
}

func copyQAFile(src, dst string) error {
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// seedQAResume puts the resumed checklist into the live snapshot: finished
// steps stay finished, a step that was running when it broke off is open
// again.
func seedQAResume(p *qaRunProgress, r *qaResume) {
	p.Plan = r.Plan
	p.Todos = make([]qaTodo, 0, len(r.Todos))
	for _, t := range r.Todos {
		if t.State == "doing" {
			t.State, t.Result = "todo", ""
		}
		p.Todos = append(p.Todos, t)
	}
}

// qaAssignImages gives the step at idx every screenshot in runDir that no
// step owns yet (sorted by name, which the prompt's r<N>-NN- prefix makes
// chronological). Called when a step finishes.
func qaAssignImages(p *qaRunProgress, idx int, runDir string) {
	if idx < 0 || idx >= len(p.Todos) || runDir == "" {
		return
	}
	owned := map[string]bool{}
	for _, t := range p.Todos {
		for _, n := range t.Images {
			owned[n] = true
		}
	}
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && qaImageFileRe.MatchString(e.Name()) && !owned[e.Name()] {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		if len(p.Todos[idx].Images) >= qaMaxStepImages {
			break
		}
		p.Todos[idx].Images = append(p.Todos[idx].Images, n)
	}
}

// applyQAMarkerInRun is applyQAMarker plus the screenshot attribution: a step
// that finishes (explicitly, or because the next one starts) gets the new
// screenshots.
func applyQAMarkerInRun(p *qaRunProgress, kind, text, runDir string) {
	prevDoing := -1
	for i, t := range p.Todos {
		if t.State == "doing" {
			prevDoing = i
		}
	}
	applyQAMarker(p, kind, text)
	switch kind {
	case "qa-done":
		f := strings.Fields(strings.SplitN(text, "|", 2)[0])
		if len(f) > 0 {
			if i := qaTodoIndex(p, f[0]); i >= 0 && p.Todos[i].State == "done" {
				qaAssignImages(p, i, runDir)
			}
		}
	case "qa-doing", "qa-step":
		if prevDoing >= 0 && prevDoing < len(p.Todos) && p.Todos[prevDoing].State == "done" {
			qaAssignImages(p, prevDoing, runDir)
		}
	}
}

// qaResumePromptSection is the "Hervatting" part of the prompt.
func qaResumePromptSection(r *qaResume) string {
	var b strings.Builder
	if r.FromRound > 0 {
		fmt.Fprintf(&b, "HERVATTING: ronde %d stopte zonder verslag. Ga verder waar die gebleven was.\n", r.FromRound)
	} else {
		b.WriteString("HERVATTING: deze run werd onderbroken (slash herstartte). Ga verder waar je gebleven was.\n")
	}
	if r.Plan != "" {
		fmt.Fprintf(&b, "Plan: %s\n", r.Plan)
	}
	b.WriteString("Stappen tot nu toe (id · status · titel — bevinding [screenshots]):\n")
	for _, t := range r.Todos {
		state := "nog te doen"
		switch t.State {
		case "done":
			state = "klaar, " + t.Result
		case "doing":
			state = "onderbroken, opnieuw doen"
		}
		fmt.Fprintf(&b, "- %s · %s · %s", t.ID, state, t.Title)
		if t.Finding != "" {
			fmt.Fprintf(&b, " — %s", t.Finding)
		}
		if len(t.Images) > 0 {
			fmt.Fprintf(&b, " [%s]", strings.Join(t.Images, ", "))
		}
		b.WriteString("\n")
	}
	if r.PrevHead != "" && r.Head != "" && r.PrevHead != r.Head {
		fmt.Fprintf(&b, "\nDe code is sindsdien veranderd: die stappen draaiden op %s, de werkmap staat nu op %s. "+
			"Bekijk `git log --oneline %s..%s` en `git diff --stat %s %s`, doe ALLEEN de afgeronde stappen opnieuw die door die wijziging geraakt worden, en zet in `deviations` welke je opnieuw deed.\n",
			qaShortSHA(r.PrevHead), qaShortSHA(r.Head), r.PrevHead, r.Head, r.PrevHead, r.Head)
	}
	b.WriteString("\nDoe de afgeronde stappen NIET opnieuw. Deze stappenlijst staat al zo in slash: schrijf geen nieuw plan, voeg alleen stappen toe die erbij moeten (`[slash:qa-todo]`, nieuwe id) en gebruik voor de rest dezelfde id's met `[slash:qa-doing]`/`[slash:qa-done]`. " +
		"Controleer eerst kort of de stack draait en log opnieuw in (de browser is nieuw), en ga dan verder met de eerste open stap. " +
		"Het JSON-eindverslag bevat ALLE stappen, ook de afgeronde: schrijf die uit de bevinding hierboven en gebruik hun screenshots (ze staan al in de screenshotmap).\n\n")
	return b.String()
}

func qaShortSHA(s string) string {
	if len(s) > 11 {
		return s[:11]
	}
	return s
}

// qaResumeDeviation is the line the report's first page shows for a resumed
// run (Go-authored, so it is there even if Claude forgets).
func qaResumeDeviation(r *qaResume) []string {
	var out []string
	n := qaDoneCount(r.Todos)
	if r.FromRound > 0 {
		out = append(out, fmt.Sprintf("Hervat vanaf ronde %d (die stopte zonder verslag): %d afgeronde stap(pen) overgenomen in plaats van opnieuw gedaan.", r.FromRound, n))
	} else {
		out = append(out, fmt.Sprintf("Deze run werd onderbroken door een herstart van slash en is hervat: %d afgeronde stap(pen) overgenomen in plaats van opnieuw gedaan.", n))
	}
	if r.PrevHead != "" && r.Head != "" && r.PrevHead != r.Head {
		out = append(out, fmt.Sprintf("De code veranderde tussen de onderbreking en het hervatten (%s → %s); alleen de geraakte stappen zijn opnieuw gedaan.", qaShortSHA(r.PrevHead), qaShortSHA(r.Head)))
	}
	return out
}
