// plan_workflow.go — the `plan` tracker behind the /plan/<JIRA-KEY> page.
//
// One long-lived Execution per Jira issue (Run ID "plan-<KEY>", so a repeated
// start is an idempotent reuse). It:
//
//  1. reads the ticket (title + description) via the jira module,
//  2. asks Claude for the CLARIFYING QUESTIONS it still has before the plan is
//     good enough — each with concrete answer options, each option carrying
//     example-code blocks (possibly nested) — plus the "what has to be done"
//     task list that follows from the ticket,
//  3. stores the whole document in the plan read-model, and then
//  4. waits for `plan_answer` Signals (the reviewer picking an option and
//     optionally typing extra detail) and regenerates the TASK LIST from the
//     answers so far, keeping the questions themselves stable.
//
// Determinism (.claude/rules/workflow-determinism.md): every side effect (Jira,
// claude, the store) is an Activity, the answer list is folded from the
// recorded Signals in history order, and the Activity order per loop iteration
// is fixed. Nothing reads the clock in the workflow body — the timestamp on the
// document comes back from an Activity result.
//
// See .claude/docs/plan-page.md.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/langpref"
)

const (
	// WorkflowPlan is the Workflow Type of the per-ticket planning tracker.
	WorkflowPlan = "plan"
	// SignalPlanAnswer carries ONE answer of the reviewer: which option of
	// which question, plus the free-text detail typed next to it.
	SignalPlanAnswer = "plan_answer"
	// SignalPlanScope answers the question a ticket WITH subtasks is asked
	// before anything else: plan the main task itself, or one of its subtasks?
	// Only "the main task" is ever signalled — picking a subtask is plain
	// navigation to that subtask's own /plan page, which has its own tracker.
	SignalPlanScope = "plan_scope"
)

// planKeyPattern is the same shape modules/jira validates against, plus the
// bare numeric form the page's route also accepts. Nothing derived from it ever
// reaches a subprocess without the jira module validating it again.
var planKeyPattern = regexp.MustCompile(`^([A-Z][A-Z0-9]+-\d+|\d+)$`)

// maxPlanQuestions/maxPlanOptions/maxPlanTasks keep one answer small enough to
// arrive well inside the module's own context timeout, and keep the page
// readable: a wall of twenty questions is not a plan.
const (
	maxPlanQuestions = 5
	maxPlanOptions   = 4
	maxPlanTasks     = 12
)

// PlanInput starts a plan Execution.
type PlanInput struct {
	Key string `json:"key"`
}

// PlanAnswerSignal is one reviewer answer. Text is the free-text field next to
// the chosen option ("" when they only picked the option).
type PlanAnswerSignal struct {
	QuestionID string `json:"questionId"`
	OptionID   string `json:"optionId"`
	Text       string `json:"text"`
}

// planBlock is one example-code block, as rendered in the page's third column.
// Children nest arbitrarily deep — that nesting is exactly what makes the plan
// readable, so it is kept rather than flattened.
type planBlock struct {
	Title    string      `json:"title"`
	Label    string      `json:"label,omitempty"`
	Lang     string      `json:"lang,omitempty"`
	Code     string      `json:"code"`
	Note     string      `json:"note,omitempty"`
	Children []planBlock `json:"children,omitempty"`
}

// planOption is one answer option of one question.
type planOption struct {
	ID     string      `json:"id"`
	Label  string      `json:"label"`
	Detail string      `json:"detail,omitempty"`
	Blocks []planBlock `json:"blocks,omitempty"`
}

// planQuestion is one clarifying question.
type planQuestion struct {
	ID       string       `json:"id"`
	Question string       `json:"question"`
	Why      string       `json:"why,omitempty"`
	Options  []planOption `json:"options"`
}

// planTask is one entry of the "what has to be done" list under the questions.
type planTask struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Explanation string      `json:"explanation,omitempty"`
	Blocks      []planBlock `json:"blocks,omitempty"`
}

// planSubtask is one child issue hanging under this ticket, as shown in the
// scope question.
type planSubtask struct {
	Key    string `json:"key"`
	Title  string `json:"title,omitempty"`
	Status string `json:"status,omitempty"`
}

// PlanScopeSignal answers the scope question. Choice is always "parent" today
// (the only choice that keeps THIS tracker going); it is carried explicitly so
// a later third option does not need a new Signal.
type PlanScopeSignal struct {
	Choice string `json:"choice"`
}

// planAnswer is one stored reviewer answer (the Signal, kept on the document).
type planAnswer struct {
	QuestionID string `json:"questionId"`
	OptionID   string `json:"optionId"`
	Text       string `json:"text,omitempty"`
}

// planDoc is the whole document the page renders — see modules/plan.
type planDoc struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
	// ParentKey/ParentTitle/ParentDescription describe the MAIN task when this
	// ticket is a subtask: context for the prompt and a link in the first
	// column, never something the plan itself covers. Subtasks is the mirror
	// image — the children of a main task, which is what the scope question
	// below offers. NeedsScope is true while the tracker is parked on the
	// SignalPlanScope wait, i.e. the page must ask before showing the rest.
	ParentKey         string         `json:"parentKey,omitempty"`
	ParentTitle       string         `json:"parentTitle,omitempty"`
	ParentDescription string         `json:"parentDescription,omitempty"`
	Subtasks          []planSubtask  `json:"subtasks,omitempty"`
	NeedsScope        bool           `json:"needsScope,omitempty"`
	Questions         []planQuestion `json:"questions"`
	Tasks             []planTask     `json:"tasks"`
	Answers           []planAnswer   `json:"answers"`
	UpdatedAt         string         `json:"updatedAt,omitempty"`
	// Error is a short reason the questions/tasks are empty (Jira or Claude
	// unreachable, SLASH_CLAUDE=off). The page shows it as a note, never as an
	// error wall — same "never cry wolf" rule as the Jira sections.
	Error string `json:"error,omitempty"`
}

// planGenerateArg is what the generate Activity gets: the document so far plus
// what it should (re)generate. "all" is the first pass (questions + tasks);
// "tasks" runs after every answer, so the questions the reviewer is halfway
// through answering never move under their hands.
type planGenerateArg struct {
	Doc  planDoc `json:"doc"`
	Mode string  `json:"mode"`
}

// planRunID is the deterministic Run ID: one tracker per ticket, forever.
func planRunID(key string) string { return "plan-" + key }

// planWorkflow is the tracker described at the top of this file.
func planWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in PlanInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	var doc planDoc
	if err := w.ExecuteActivity("planLoadIssue", in, &doc); err != nil {
		return nil, fmt.Errorf("plan: load issue: %w", err)
	}
	// A ticket with subtasks is not planned until the reviewer says WHAT is
	// being planned: this main task, or one of its subtasks. The gate sits in
	// the workflow rather than only in the page because planGenerate is a
	// minutes-long Claude call — one that must not be paid for a main task the
	// reviewer immediately trades for a subtask. The document is saved first so
	// the page can render the question at all; picking a subtask simply opens
	// that subtask's own /plan page and leaves this tracker parked here.
	if len(doc.Subtasks) > 0 {
		doc.NeedsScope = true
		if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
			return nil, fmt.Errorf("plan: save scope question: %w", err)
		}
		var scope PlanScopeSignal
		w.WaitSignal(SignalPlanScope, &scope)
		doc.NeedsScope = false
	}
	if err := w.ExecuteActivity("planGenerate", planGenerateArg{Doc: doc, Mode: "all"}, &doc); err != nil {
		return nil, fmt.Errorf("plan: generate: %w", err)
	}
	if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
		return nil, fmt.Errorf("plan: save: %w", err)
	}
	for {
		var sig PlanAnswerSignal
		w.WaitSignal(SignalPlanAnswer, &sig)
		doc.Answers = upsertPlanAnswer(doc.Answers, sig)
		// Store the answer FIRST, then regenerate: the regeneration is a
		// minute-long Claude call, and until it lands the page would otherwise
		// keep reading a document that does not know about the choice the
		// reviewer just made (its own optimistic copy is dropped on the next
		// poll).
		if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
			return nil, fmt.Errorf("plan: save answer: %w", err)
		}
		if err := w.ExecuteActivity("planGenerate", planGenerateArg{Doc: doc, Mode: "tasks"}, &doc); err != nil {
			return nil, fmt.Errorf("plan: regenerate tasks: %w", err)
		}
		if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
			return nil, fmt.Errorf("plan: save: %w", err)
		}
	}
}

// upsertPlanAnswer replaces the answer for a question, or appends a new one —
// a pure function of (list, signal), so replay reproduces it exactly. An empty
// OptionID clears the answer again.
func upsertPlanAnswer(list []planAnswer, sig PlanAnswerSignal) []planAnswer {
	out := make([]planAnswer, 0, len(list)+1)
	for _, a := range list {
		if a.QuestionID != sig.QuestionID {
			out = append(out, a)
		}
	}
	if sig.OptionID != "" || strings.TrimSpace(sig.Text) != "" {
		out = append(out, planAnswer{QuestionID: sig.QuestionID, OptionID: sig.OptionID, Text: strings.TrimSpace(sig.Text)})
	}
	return out
}

// StartPlan starts (or idempotently reuses) the tracker for key and returns its
// Run ID. Starting an Execution is the sanctioned UI write path.
func (m *TaskManager) StartPlan(key string) (string, error) {
	key = strings.ToUpper(strings.TrimSpace(key))
	if !planKeyPattern.MatchString(key) {
		return "", fmt.Errorf("plan: invalid issue key %q", key)
	}
	return m.engine.StartWorkflowID(planRunID(key), WorkflowPlan, PlanInput{Key: key})
}

// PlanDoc reads the stored document for key (read-only, for GET /api/plan).
func (m *TaskManager) PlanDoc(ctx context.Context, key string) (planDoc, bool) {
	var doc planDoc
	if m == nil || m.plan == nil {
		return doc, false
	}
	raw, ok, err := m.plan.Get(ctx, key)
	if err != nil || !ok {
		return doc, false
	}
	if json.Unmarshal([]byte(raw), &doc) != nil {
		return doc, false
	}
	return doc, true
}

// RunsForPlan lists the workflow runs belonging to ONE plan — every Execution
// whose input carries this issue key. Today that is the tracker itself; a later
// per-ticket workflow lands in the same list for free, which is exactly why the
// filter is on the input rather than on the Workflow Type.
func (m *TaskManager) RunsForPlan(key string) []WorkflowRunView {
	runs, err := m.engine.Runs()
	if err != nil {
		return nil
	}
	out := make([]WorkflowRunView, 0, 4)
	for _, r := range runs {
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var input struct {
			Key string `json:"key"`
		}
		if json.Unmarshal(in, &input) != nil || !strings.EqualFold(input.Key, key) {
			continue
		}
		out = append(out, WorkflowRunView{
			RunID: r.ID, Workflow: r.Workflow, Status: r.Status,
			CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		})
	}
	return out
}

// registerPlanActivities wires the three Activities. Called from
// registerWorkflows in workflows.go.
func (m *TaskManager) registerPlanActivities(engine *tembed.Engine) {
	// Activity: read the ticket itself (external call, hence an Activity). A
	// failure yields a document carrying the reason rather than sinking the
	// tracker — the page then shows the ticket key and the note, and a later
	// answer/restart retries.
	engine.RegisterActivity("planLoadIssue", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg PlanInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		doc := planDoc{Key: arg.Key, Questions: []planQuestion{}, Tasks: []planTask{}, Answers: []planAnswer{}}
		if m.jira == nil {
			doc.Error = "jira client unavailable"
			return json.Marshal(doc)
		}
		issue, err := m.jira.Issue(ctx, arg.Key)
		if err != nil {
			m.logf("plan: load issue %s: %v", arg.Key, err)
			doc.Error = err.Error()
			return json.Marshal(doc)
		}
		doc.Title, doc.Description, doc.URL = issue.Title, issue.Description, issue.URL
		doc.ParentKey, doc.ParentTitle = issue.ParentKey, issue.ParentTitle
		for _, st := range issue.Subtasks {
			doc.Subtasks = append(doc.Subtasks, planSubtask{Key: st.Key, Title: st.Title, Status: st.Status})
		}
		// A subtask is planned WITH its main task in view: read the parent's
		// own description too (the parent field itself carries only a summary).
		// Best-effort — a failure here leaves the plan without that context
		// rather than sinking the tracker.
		if doc.ParentKey != "" {
			if parent, perr := m.jira.Issue(ctx, doc.ParentKey); perr != nil {
				m.logf("plan: load parent %s of %s: %v", doc.ParentKey, arg.Key, perr)
			} else {
				doc.ParentDescription = parent.Description
				if strings.TrimSpace(parent.Title) != "" {
					doc.ParentTitle = parent.Title
				}
			}
		}
		return json.Marshal(doc)
	})
	// Activity: ask Claude for the questions and/or the task list (shells out to
	// the claude CLI). Best-effort: a hiccup (or SLASH_CLAUDE=off) leaves the
	// document as it was, with the reason on it.
	engine.RegisterActivity("planGenerate", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg planGenerateArg
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		doc := arg.Doc
		doc.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if m.claude == nil || strings.TrimSpace(doc.Title)+strings.TrimSpace(doc.Description) == "" {
			if doc.Error == "" {
				doc.Error = "no ticket content to plan from"
			}
			return json.Marshal(doc)
		}
		raw, err := m.claude.Run(ctx, claude.RunRequest{
			Model:  claude.ModelSonnet,
			Prompt: planPrompt(doc, arg.Mode) + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
		})
		if err != nil {
			m.logf("plan: generate %s (%s): %v", doc.Key, arg.Mode, err)
			doc.Error = err.Error()
			return json.Marshal(doc)
		}
		qs, tasks, perr := parsePlanAnswer(raw)
		if perr != nil {
			m.logf("plan: parse %s (%s): %v", doc.Key, arg.Mode, perr)
			doc.Error = perr.Error()
			return json.Marshal(doc)
		}
		doc.Error = ""
		if arg.Mode == "all" {
			doc.Questions = qs
		}
		doc.Tasks = tasks
		return json.Marshal(doc)
	})
	// Activity: persist the document (write, workflow-driven).
	engine.RegisterActivity("planSave", func(ctx context.Context, in []byte) ([]byte, error) {
		var doc planDoc
		if err := json.Unmarshal(in, &doc); err != nil {
			return nil, err
		}
		if m.plan == nil || doc.Key == "" {
			return nil, nil
		}
		raw, err := json.Marshal(doc)
		if err != nil {
			return nil, err
		}
		return nil, m.plan.Save(ctx, doc.Key, string(raw), doc.UpdatedAt)
	})
}
