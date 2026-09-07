// jira_comment.go — Workflow Type `jira_comment`: post ONE comment on a Jira
// issue, on behalf of the plan page's comment panel (see
// .claude/docs/plan-page.md, "Jira-opmerkingen: lezen, beantwoorden,
// @-mentions").
//
// WHY ITS OWN WORKFLOW instead of another Kind on the `plan` tracker's
// plan_answer Signal (the way the general chat rides along): the tracker can be
// parked on the scope or hotfix gate, and a Signal aimed at a name it is not
// currently waiting on is recorded but only consumed once that gate is
// answered — a reply to a Jira comment would then silently sit there. Posting
// a comment also has nothing to do with the plan document; it is a one-shot
// external write, so it gets a one-shot Execution: one Activity, no signals, no
// loop, trivially deterministic (.claude/rules/workflow-determinism.md).
//
// The run carries `key` on its input, so it shows up in the plan page's own
// "Taken" card for free (RunsForPlan, plan_workflow.go).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/reindert-vetter/tembed"
	"slash/modules/jira"
)

// WorkflowJiraComment is the Workflow Type of one posted Jira comment.
const WorkflowJiraComment = "jira_comment"

// JiraCommentInput is one comment to post: on which issue, the typed body, and
// the mentions picked while typing (see jira.BuildCommentADF).
type JiraCommentInput struct {
	Key      string         `json:"key"`
	Body     string         `json:"body"`
	Mentions []jira.Mention `json:"mentions,omitempty"`
}

// JiraCommentResult is what the run leaves in its own history.
type JiraCommentResult struct {
	Key       string `json:"key"`
	CommentID string `json:"commentId,omitempty"`
}

// validJiraCommentInput is the one validator both the HTTP handler and the
// workflow body run: every field here reaches an external API, so it is
// checked before it leaves the process and again after it comes back out of
// the recorded history (.claude/rules/conventions.md).
func validJiraCommentInput(in JiraCommentInput) error {
	key := strings.ToUpper(strings.TrimSpace(in.Key))
	if !planKeyPattern.MatchString(key) || strings.IndexByte(key, '-') < 0 {
		return fmt.Errorf("jira comment: invalid issue key %q", in.Key)
	}
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return fmt.Errorf("jira comment: empty body")
	}
	if len(body) > jira.MaxCommentBody {
		return fmt.Errorf("jira comment: body too long")
	}
	if len(in.Mentions) > 20 {
		return fmt.Errorf("jira comment: too many mentions")
	}
	for _, m := range in.Mentions {
		if !jira.ValidMention(m) {
			return fmt.Errorf("jira comment: invalid mention")
		}
	}
	return nil
}

// jiraCommentWorkflow is the whole workflow: validate what the history says,
// then one Activity that actually posts.
func jiraCommentWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in JiraCommentInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	if err := validJiraCommentInput(in); err != nil {
		return nil, err
	}
	var res JiraCommentResult
	if err := w.ExecuteActivity("postJiraComment", in, &res); err != nil {
		return nil, fmt.Errorf("jira comment: post: %w", err)
	}
	return json.Marshal(res)
}

// registerJiraCommentActivities wires the single Activity. Called from
// registerWorkflows in workflows.go.
func (m *TaskManager) registerJiraCommentActivities(engine *tembed.Engine) {
	// Activity: the module write itself — the ONLY place a Jira comment is
	// posted (.claude/rules/workflows-write-boundary.md).
	engine.RegisterActivity("postJiraComment", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg JiraCommentInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if err := validJiraCommentInput(arg); err != nil {
			return nil, err
		}
		if m.jira == nil {
			return nil, fmt.Errorf("jira comment: no jira client")
		}
		key := strings.ToUpper(strings.TrimSpace(arg.Key))
		id, err := m.jira.AddComment(ctx, key, jira.BuildCommentADF(arg.Body, arg.Mentions))
		if err != nil {
			m.logf("jira comment: post %s: %v", key, err)
			return nil, err
		}
		// The panel's own day-long cache (plan_comments.go) must not keep
		// serving a list that predates this very comment.
		invalidatePlanComments(key)
		return json.Marshal(JiraCommentResult{Key: key, CommentID: id})
	})
}

// StartJiraComment starts one posting run. No deterministic Run ID: two
// comments on the same ticket are simply two runs.
func (m *TaskManager) StartJiraComment(in JiraCommentInput) (string, error) {
	if m == nil || m.engine == nil {
		return "", fmt.Errorf("no engine")
	}
	if err := validJiraCommentInput(in); err != nil {
		return "", err
	}
	in.Key = strings.ToUpper(strings.TrimSpace(in.Key))
	in.Body = strings.TrimSpace(in.Body)
	return m.engine.StartWorkflow(WorkflowJiraComment, in)
}

// handleJiraCommentStart serves POST /api/workflows/jira_comment — the plan
// page's comment panel posting a reply. The sanctioned UI write path: start an
// Execution, never a module write from a handler.
func (s *server) handleJiraCommentStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body JiraCommentInput
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if err := validJiraCommentInput(body); err != nil {
		http.Error(w, "invalid jira comment", http.StatusBadRequest)
		return
	}
	runID, err := s.tasks.manager.StartJiraComment(body)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"runId": runID})
}
