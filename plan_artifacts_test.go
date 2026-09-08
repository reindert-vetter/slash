package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestPlanPhaseFollowsTheDocument covers the phase transitions — the one piece
// of state this feature deliberately does NOT store (see planPhase): a document
// that only loaded is in `intent`, one with questions in `specs`, one with
// tasks in `plan`.
func TestPlanPhaseFollowsTheDocument(t *testing.T) {
	intent := planDoc{Key: "PAYM-813", Title: "Iets"}
	specs := planDoc{Key: "PAYM-813", Questions: []planQuestion{{ID: "q1", Question: "Waarom?"}}}
	// Generated, but the question is still open: the stage the reviewer really
	// spends the planning in — NOT the plan stage, even though tasks exist.
	generated := planDoc{
		Key:       "PAYM-813",
		Questions: []planQuestion{{ID: "q1", Question: "Waarom?"}},
		Tasks:     []planTask{{ID: "t1", Title: "Doe iets"}},
	}
	answered := generated
	answered.Answers = []planAnswer{{QuestionID: "q1", OptionID: "q1o1"}}
	// A task list without any question at all is settled by definition: there
	// is nothing left open (a follow-up round can leave the questions empty).
	tasksOnly := planDoc{Key: "PAYM-813", Tasks: []planTask{{ID: "t1", Title: "Doe iets"}}}
	// A half-answered set is still the specs stage.
	half := planDoc{
		Key:       "PAYM-813",
		Questions: []planQuestion{{ID: "q1"}, {ID: "q2"}},
		Tasks:     []planTask{{ID: "t1", Title: "Doe iets"}},
		Answers:   []planAnswer{{QuestionID: "q1", OptionID: "q1o1"}},
	}

	for _, tc := range []struct {
		name string
		doc  planDoc
		want string
	}{
		{"loaded only", intent, planPhaseIntent},
		{"questions, nothing generated further", specs, planPhaseSpecs},
		{"generated but unanswered", generated, planPhaseSpecs},
		{"half answered", half, planPhaseSpecs},
		{"every question answered", answered, planPhasePlan},
		{"tasks without questions", tasksOnly, planPhasePlan},
	} {
		if got := planPhase(tc.doc); got != tc.want {
			t.Errorf("%s: planPhase = %q, want %q", tc.name, got, tc.want)
		}
	}

	// planHasPhaseContent is the SEPARATE rule deciding which files exist: the
	// stage says how far the reviewer is, a file says what is known.
	if !planHasPhaseContent(intent, planPhaseIntent) {
		t.Error("intent.md is always written")
	}
	if planHasPhaseContent(intent, planPhaseSpecs) || planHasPhaseContent(intent, planPhasePlan) {
		t.Error("a ticket that only loaded has no spec/plan content")
	}
	if !planHasPhaseContent(generated, planPhasePlan) {
		t.Error("plan.md is written as the current draft as soon as there are tasks")
	}
	if planHasPhaseContent(specs, planPhasePlan) {
		t.Error("no tasks means no plan.md")
	}
}

// TestWritePlanArtifactsPerPhase is the on-disk half of the same rule: a phase
// that has not been reached writes NO file at all (three stubs would make the
// three stages unreadable), and advancing a phase adds exactly one file without
// disturbing the earlier ones.
func TestWritePlanArtifactsPerPhase(t *testing.T) {
	dir := t.TempDir()
	doc := planDoc{Key: "PAYM-813", Title: "Drie fases", Description: "Doe het in drie stappen."}

	written, err := writePlanArtifacts(dir, doc)
	if err != nil {
		t.Fatalf("write intent: %v", err)
	}
	if len(written) != 1 || written[0] != "intent.md" {
		t.Fatalf("intent phase wrote %v, want only intent.md", written)
	}
	base := filepath.Join(dir, "plans", "PAYM-813")
	for _, name := range []string{"spec.md", "plan.md"} {
		if _, err := os.Stat(filepath.Join(base, name)); !os.IsNotExist(err) {
			t.Errorf("%s must not exist in the intent phase (err=%v)", name, err)
		}
	}

	doc.Questions = []planQuestion{{ID: "q1", Question: "Hotfix?", Options: []planOption{{ID: "q1o1", Label: "Ja"}, {ID: "q1o2", Label: "Nee"}}}}
	written, err = writePlanArtifacts(dir, doc)
	if err != nil {
		t.Fatalf("write specs: %v", err)
	}
	if strings.Join(written, ",") != "intent.md,spec.md" {
		t.Fatalf("specs phase wrote %v, want intent.md + spec.md in that order", written)
	}

	doc.Tasks = []planTask{{ID: "t1", Title: "Voeg de fases toe"}}
	written, err = writePlanArtifacts(dir, doc)
	if err != nil {
		t.Fatalf("write plan: %v", err)
	}
	if strings.Join(written, ",") != "intent.md,spec.md,plan.md" {
		t.Fatalf("plan phase wrote %v, want all three in order", written)
	}

	// No residue: exactly the three artifacts, no leftover temp file from the
	// atomic write (the "een half afgebroken run laat geen rommel achter" rule).
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 3 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("directory holds %v, want exactly the three artifacts", names)
	}
}

// TestPlanArtifactContent asserts the three files really carry the three
// DIFFERENT things — intent the ticket, spec the questions plus the picked
// answer, plan the tasks with their concrete fields — including the main task a
// subtask is planned under, which is the half of the reviewer's own request
// ("en hoofdtaak als het om een subticket gaat") that could silently go missing.
func TestPlanArtifactContent(t *testing.T) {
	dir := t.TempDir()
	doc := planDoc{
		Key:               "PAYM-813",
		Title:             "Drie fases",
		Description:       "Het plannen krijgt drie fases.",
		URL:               "https://example.atlassian.net/browse/PAYM-813",
		ParentKey:         "PAYM-800",
		ParentTitle:       "Planpagina",
		ParentDescription: "De hele planpagina.",
		Hotfix:            true,
		BaseBranch:        "master",
		Assignee:          "Reindert",
		Comments:          []planComment{{Author: "Dennis", Created: "2026-09-01", Body: "hoeft dus niet"}},
		Questions: []planQuestion{{
			ID:       "q1",
			Question: "Waar komen de bestanden?",
			Why:      "Het moet opgeruimd kunnen worden.",
			Options:  []planOption{{ID: "q1o1", Label: "In data/"}, {ID: "q1o2", Label: "In de repo"}},
		}, {
			ID:       "q2",
			Question: "Nog niet beantwoord",
			Options:  []planOption{{ID: "q2o1", Label: "A"}},
		}},
		Answers: []planAnswer{{QuestionID: "q1", OptionID: "q1o1", Text: "gitignored graag"}},
		Tasks: []planTask{{
			ID:          "t1",
			Title:       "Schrijf de drie bestanden",
			Explanation: "Vanuit planSave.",
			Location:    "plan_artifacts.go",
			Conditions:  []string{"alleen als de fase bereikt is"},
			Config:      []string{"planArtifactAge = 30d"},
			Blocks:      []planBlock{{Title: "plan_artifacts.go", Lang: "go", Code: "func writePlanArtifacts() {}", Note: "de writer", Children: []planBlock{{Title: "kind", Code: "x := 1", Note: "waarom eronder"}}}},
		}, {
			ID:    "t2",
			Title: "Overgeslagen taak",
		}},
		TaskStates: []planTaskState{{Key: planTaskKey("Overgeslagen taak"), Title: "Overgeslagen taak", Off: true, Note: "later"}},
	}
	if _, err := writePlanArtifacts(dir, doc); err != nil {
		t.Fatalf("write: %v", err)
	}
	base := filepath.Join(dir, "plans", "PAYM-813")
	read := func(name string) string {
		raw, err := os.ReadFile(filepath.Join(base, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(raw)
	}

	intent := read("intent.md")
	for _, want := range []string{
		"# Intent — PAYM-813 Drie fases",
		"Phase 1 of 3 — **intent**",
		"Het plannen krijgt drie fases.",
		"main task **PAYM-800**",
		"### Main task PAYM-800",
		"Hotfix: goes out from `master`",
		"hoeft dus niet",
	} {
		if !strings.Contains(intent, want) {
			t.Errorf("intent.md misses %q", want)
		}
	}
	// The intent is the ticket, never the plan: no task titles in it.
	if strings.Contains(intent, "Schrijf de drie bestanden") {
		t.Error("intent.md must not carry the task list")
	}

	spec := read("spec.md")
	for _, want := range []string{
		"# Spec — PAYM-813",
		"Phase 2 of 3 — **specs**",
		"Base branch: `master` (hotfix)",
		"### 1. Waar komen de bestanden?",
		"- [x] In data/",
		"- [ ] In de repo",
		"**The reviewer added:** gitignored graag",
		"**Still open**",
	} {
		if !strings.Contains(spec, want) {
			t.Errorf("spec.md misses %q", want)
		}
	}

	plan := read("plan.md")
	for _, want := range []string{
		"# Plan — PAYM-813",
		"Phase 3 of 3 — **plan**",
		"## 1. [x] Schrijf de drie bestanden — meenemen",
		"**Location:** plan_artifacts.go",
		"**Conditions:** alleen als de fase bereikt is",
		"**Config:** planArtifactAge = 30d",
		"```go",
		"waarom eronder", // a nested block keeps its own note, at every level
		"## 2. [ ] Overgeslagen taak — overslaan",
		"**The reviewer added:** later",
	} {
		if !strings.Contains(plan, want) {
			t.Errorf("plan.md misses %q", want)
		}
	}
	// A field the model left empty is omitted, never rendered as "n.v.t.".
	if strings.Contains(plan, "**Migration:**") {
		t.Error("plan.md renders an empty field")
	}
}

// TestPlanArtifactDirRefusesAnUnusableKey — the key reaches the filesystem, so
// it is validated before it is ever joined onto a path.
func TestPlanArtifactDirRefusesAnUnusableKey(t *testing.T) {
	for _, key := range []string{"", "../../etc", "PAYM-813/../..", "paym 813", "PAYM-813; rm -rf /"} {
		if _, err := planArtifactDir("/tmp/data", key); err == nil {
			t.Errorf("planArtifactDir accepted %q", key)
		}
	}
	got, err := planArtifactDir("/tmp/data", "paym-813")
	if err != nil {
		t.Fatalf("lowercase key refused: %v", err)
	}
	if got != filepath.Join("/tmp/data", "plans", "PAYM-813") {
		t.Errorf("planArtifactDir = %q", got)
	}
}

// TestPlanArtifactsRemovedWithTheirPR is the cleanup rule the reviewer asked
// for: the directory goes away when the PR that came out of the plan is
// purged (merged and older than cleanupMergedAge, decided by the existing
// gate), and a directory belonging to ANOTHER PR is left alone.
func TestPlanArtifactsRemovedWithTheirPR(t *testing.T) {
	dir := t.TempDir()
	for _, key := range []string{"PAYM-813", "PAYM-900"} {
		if _, err := writePlanArtifacts(dir, planDoc{Key: key, Title: key}); err != nil {
			t.Fatalf("write %s: %v", key, err)
		}
	}
	writePlanArtifactPR(dir, "PAYM-813", 4242)
	writePlanArtifactPR(dir, "PAYM-900", 99)

	if got := planArtifactDirsForPR(dir, 4242); len(got) != 1 || !strings.HasSuffix(got[0], "PAYM-813") {
		t.Fatalf("planArtifactDirsForPR(4242) = %v", got)
	}
	n, err := removePlanArtifactsForPR(dir, 4242)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if n != 1 {
		t.Fatalf("removed %d directories, want 1", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "plans", "PAYM-813")); !os.IsNotExist(err) {
		t.Error("PAYM-813 artifacts survived the purge of their own PR")
	}
	if _, err := os.Stat(filepath.Join(dir, "plans", "PAYM-900")); err != nil {
		t.Errorf("another PR's artifacts were removed: %v", err)
	}
	// Idempotent: a second cleanup pass finds nothing and never errors.
	if n, err := removePlanArtifactsForPR(dir, 4242); err != nil || n != 0 {
		t.Errorf("second pass: n=%d err=%v, want 0/nil", n, err)
	}
	// A PR nobody's plan produced removes nothing, and a missing root is fine.
	if n, err := removePlanArtifactsForPR(dir, 7); err != nil || n != 0 {
		t.Errorf("unknown pr: n=%d err=%v", n, err)
	}
	if n, err := removePlanArtifactsForPR(t.TempDir(), 4242); err != nil || n != 0 {
		t.Errorf("missing root: n=%d err=%v", n, err)
	}
}

// TestSweepPlanArtifacts is the safety net under that rule: a plan that never
// reached a PR (abandoned, or a run that broke halfway) is swept on its OWN
// age, and one that DOES carry a PR marker is left to purgePR however old it
// is — its pull request may still be open.
func TestSweepPlanArtifacts(t *testing.T) {
	dir := t.TempDir()
	for _, key := range []string{"PAYM-1", "PAYM-2", "PAYM-3"} {
		if _, err := writePlanArtifacts(dir, planDoc{Key: key}); err != nil {
			t.Fatalf("write %s: %v", key, err)
		}
	}
	writePlanArtifactPR(dir, "PAYM-3", 55)

	old := time.Now().Add(-2 * planArtifactAge)
	for _, key := range []string{"PAYM-1", "PAYM-3"} {
		base := filepath.Join(dir, "plans", key)
		entries, _ := os.ReadDir(base)
		for _, e := range entries {
			if err := os.Chtimes(filepath.Join(base, e.Name()), old, old); err != nil {
				t.Fatalf("chtimes: %v", err)
			}
		}
	}

	n, err := sweepPlanArtifacts(dir, time.Now().Add(-planArtifactAge))
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("swept %d, want only the old PR-less plan", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "plans", "PAYM-1")); !os.IsNotExist(err) {
		t.Error("the old PR-less plan survived the sweep")
	}
	if _, err := os.Stat(filepath.Join(dir, "plans", "PAYM-2")); err != nil {
		t.Errorf("a fresh plan was swept: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "plans", "PAYM-3")); err != nil {
		t.Errorf("a plan with an open PR was swept: %v", err)
	}
	// A missing root is not an error — the sweep runs on every cleanup pass,
	// including on an installation that never planned anything.
	if n, err := sweepPlanArtifacts(t.TempDir(), time.Now()); err != nil || n != 0 {
		t.Errorf("missing root: n=%d err=%v", n, err)
	}
}

// TestPlanArtifactsView is what the page renders: the current phase plus the
// three files with their real existence, so a file cleanup removed stops being
// claimed the moment it is gone.
func TestPlanArtifactsView(t *testing.T) {
	dir := t.TempDir()
	doc := planDoc{Key: "PAYM-813", Questions: []planQuestion{{ID: "q1"}}}
	if _, err := writePlanArtifacts(dir, doc); err != nil {
		t.Fatalf("write: %v", err)
	}
	view, ok := planArtifactsView(dir, doc)
	if !ok {
		t.Fatal("planArtifactsView refused a valid document")
	}
	if view.Phase != planPhaseSpecs {
		t.Errorf("phase = %q, want %q", view.Phase, planPhaseSpecs)
	}
	if len(view.Files) != 3 {
		t.Fatalf("files = %d, want 3 (every phase is listed, reached or not)", len(view.Files))
	}
	if !view.Files[0].Exists || !view.Files[1].Exists {
		t.Error("intent.md/spec.md should exist in the specs phase")
	}
	if view.Files[2].Exists {
		t.Error("plan.md must not be claimed before the plan phase")
	}
	if view.Files[2].File != "plan.md" || view.Files[2].Phase != planPhasePlan {
		t.Errorf("third file = %+v", view.Files[2])
	}
	if _, ok := planArtifactsView(dir, planDoc{Key: "../etc"}); ok {
		t.Error("planArtifactsView accepted an unusable key")
	}
}

// TestRenderPlanIntentListsReferencedIssuesWithBranch pins the "Related
// tickets" section: an authoritative GitHub-PR branch is phrased differently
// from a Jira-text guess (never presented as fact), and a ticket with no
// known branch at all still says so plainly.
func TestRenderPlanIntentListsReferencedIssuesWithBranch(t *testing.T) {
	doc := planDoc{
		Key: "PROD-254", Title: "Statistieken in clickhouse",
		Referenced: []planReferencedIssue{
			{Key: "PROD-216", Title: "Productgroepen", Reason: "relates to", Branch: "feature/PROD-216-groepen", BranchSource: "pr:#4211"},
			{Key: "PROD-300", Title: "Migratie", Reason: "vermeld in tekst", Branch: "prod-300-migratie", BranchSource: "jira-tekst"},
			{Key: "PROD-9", Title: "Oud ticket", Reason: "vermeld in tekst"},
		},
	}
	got := renderPlanIntent(doc)
	for _, want := range []string{
		"## Related tickets",
		"**PROD-216** (Productgroepen) — relates to; work already on branch `feature/PROD-216-groepen` (pr:#4211)",
		"**PROD-300** (Migratie) — vermeld in tekst; possibly on branch `prod-300-migratie` (guessed from jira-tekst — unverified)",
		"**PROD-9** (Oud ticket) — vermeld in tekst; no known branch yet",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("intent misses %q\n---\n%s", want, got)
		}
	}
}

// TestRenderPlanIntentHonorsOverride asserts the reviewer's own edit of the
// "Intentie" field replaces the auto-generated document WHOLESALE — the
// generated sections (Problem/Constraints/…) must not leak through.
func TestRenderPlanIntentHonorsOverride(t *testing.T) {
	doc := planDoc{
		Key: "PROD-254", Title: "Statistieken", Description: "auto-generated problem text",
		IntentOverride: "Mijn eigen intentie: dit ticket bouwt voort op PROD-216.",
	}
	got := renderPlanIntent(doc)
	if got != doc.IntentOverride {
		t.Fatalf("renderPlanIntent = %q, want the override verbatim", got)
	}
	if strings.Contains(got, "auto-generated problem text") || strings.Contains(got, "## Problem") {
		t.Error("the override must replace the generated document, not merge with it")
	}
}
