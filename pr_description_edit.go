package main

// pr_description_edit — the reviewer edits the PR's own title + description
// inline, in the synthetic "PR-titel & omschrijving" index block, and
// "Opslaan" writes it straight to GitHub. Unlike a code block's inline edit
// (which hands the edit to a Claude chat, see .claude/docs/inline-edit.md)
// there is nothing to commit here, so this is a plain one-shot workflow:
//
//	editPrDescription (stale check + gh PATCH) → fetchPRBasics (refresh prmeta)
//
// A description that changed on GitHub since the edit started is REFUSED
// (errPrDescStale) rather than overwritten — both before the workflow starts
// (a plain read, so a doomed edit never creates a failed run) and again inside
// the Activity, right before the write.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/reindert-vetter/tembed"
)

// WorkflowPrDescriptionEdit is the Workflow Type that overwrites a PR's title
// and body on GitHub: one Execution per save, no signals, mirrors
// WorkflowSubmitReview.
const WorkflowPrDescriptionEdit = "pr_description_edit"

// GitHub's own limits for a PR title/body.
const (
	prTitleMaxRunes = 256
	prBodyMaxRunes  = 65536
)

// PrDescriptionEditInput starts a pr_description_edit Execution. BaseTitle/
// BaseBody are the title/body the reviewer's edit started from: the write is
// refused when GitHub no longer holds exactly that (normalised, see
// normalizePrBody).
type PrDescriptionEditInput struct {
	Repo      string `json:"repo,omitempty"`
	PR        int    `json:"pr"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	BaseTitle string `json:"baseTitle"`
	BaseBody  string `json:"baseBody"`
}

// errPrDescStale: the description changed on GitHub after the edit started.
var errPrDescStale = errors.New("de PR-omschrijving is intussen op GitHub gewijzigd — je concept is bewaard, bekijk de nieuwe versie en sla opnieuw op")

// normalizePrBody mirrors the frontend's prDescriptionText: CRLF → LF and
// trailing whitespace dropped, so a body typed in GitHub's web editor (\r\n)
// compares equal to the text the block shows.
func normalizePrBody(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.TrimRight(s, " \t\n")
}

// prDescMatchesBase reports whether GitHub's current title/body still equal
// the pair the edit started from.
func prDescMatchesBase(curTitle, curBody string, in PrDescriptionEditInput) bool {
	return strings.TrimSpace(curTitle) == strings.TrimSpace(in.BaseTitle) &&
		normalizePrBody(curBody) == normalizePrBody(in.BaseBody)
}

// validatePrDescriptionEdit checks the request before it reaches the workflow
// or gh, normalising in place: a known repo, a positive pr, a non-empty
// single-line title within GitHub's limit, a body within GitHub's limit.
func validatePrDescriptionEdit(in *PrDescriptionEditInput) error {
	if in.PR <= 0 {
		return fmt.Errorf("invalid pr")
	}
	if !knownRepo(in.Repo) {
		return fmt.Errorf("unknown repo")
	}
	in.Repo = canonRepo(in.Repo)
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return fmt.Errorf("de titel (eerste regel) mag niet leeg zijn")
	}
	if strings.ContainsAny(in.Title, "\r\n") {
		return fmt.Errorf("de titel moet op één regel staan")
	}
	if utf8.RuneCountInString(in.Title) > prTitleMaxRunes {
		return fmt.Errorf("de titel is langer dan %d tekens", prTitleMaxRunes)
	}
	in.Body = normalizePrBody(in.Body)
	if utf8.RuneCountInString(in.Body) > prBodyMaxRunes {
		return fmt.Errorf("de omschrijving is langer dan %d tekens", prBodyMaxRunes)
	}
	return nil
}

// prDescriptionEditWorkflow: deterministic — two Activities in a fixed order,
// no signals, no branching on anything but their results.
func prDescriptionEditWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in PrDescriptionEditInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := w.ExecuteActivity("editPrDescription", in, nil); err != nil {
		return nil, fmt.Errorf("edit pr description: %w", err)
	}
	// Refresh the prmeta read-model right away, so GET /api/pr serves the new
	// text without waiting for the pr_status tracker's next poll.
	if err := w.ExecuteActivity("fetchPRBasics", PRStatusInput{Repo: in.Repo, PR: in.PR}, nil); err != nil {
		return nil, fmt.Errorf("refresh pr basics: %w", err)
	}
	return json.Marshal(map[string]any{"pr": in.PR})
}

// registerPrDescriptionEdit registers the workflow's own Activity (the second
// step reuses the pr_status tracker's fetchPRBasics) and the Workflow Type.
func (m *TaskManager) registerPrDescriptionEdit(engine *tembed.Engine) {
	engine.RegisterActivity("editPrDescription", func(ctx context.Context, raw []byte) ([]byte, error) {
		var in PrDescriptionEditInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		if m.gh == nil {
			return nil, fmt.Errorf("edit pr description: no github client")
		}
		gh := m.ghFor(in.Repo)
		cur, err := gh.PRMeta(ctx, in.PR)
		if err != nil {
			return nil, fmt.Errorf("read current description: %w", err)
		}
		if !prDescMatchesBase(cur.Title, cur.Body, in) {
			return nil, errPrDescStale
		}
		return nil, gh.EditPullRequest(ctx, in.PR, in.Title, in.Body)
	})
	engine.RegisterWorkflow(WorkflowPrDescriptionEdit, prDescriptionEditWorkflow)
}

// StartPrDescriptionEdit runs one pr_description_edit Execution to
// completion and returns its Run ID. A stale base is refused up front
// (errPrDescStale) without starting a run; a failed run is an error.
func (m *TaskManager) StartPrDescriptionEdit(ctx context.Context, in PrDescriptionEditInput) (string, error) {
	if m.gh == nil {
		return "", fmt.Errorf("edit pr description: no github client")
	}
	cur, err := m.ghFor(in.Repo).PRMeta(ctx, in.PR)
	if err != nil {
		return "", fmt.Errorf("read current description: %w", err)
	}
	if !prDescMatchesBase(cur.Title, cur.Body, in) {
		return "", errPrDescStale
	}
	runID, err := m.engine.StartWorkflow(WorkflowPrDescriptionEdit, in)
	if err != nil {
		return "", err
	}
	status, err := m.engine.Status(runID)
	if err != nil {
		return runID, err
	}
	if status == tembed.StatusFailed {
		return runID, fmt.Errorf("PR-omschrijving opslaan mislukt (run %s)", runID)
	}
	return runID, nil
}

// handlePrDescriptionEdit: POST /api/workflows/pr_description_edit
// {repo?, pr, title, body, baseTitle, baseBody} → {runId}. 400 on invalid
// input, 409 when the description changed on GitHub meanwhile, 502 on a
// gh/workflow failure.
func (s *server) handlePrDescriptionEdit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var in PrDescriptionEditInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	if err := validatePrDescriptionEdit(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	runID, err := s.tasks.manager.StartPrDescriptionEdit(r.Context(), in)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errPrDescStale) {
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}
