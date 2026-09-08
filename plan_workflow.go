// plan_workflow.go — the `plan` tracker behind the /plan/<JIRA-KEY> page.
//
// One long-lived Execution per Jira issue (Run ID "plan-<KEY>", so a repeated
// start is an idempotent reuse). It:
//
//  1. reads the ticket (title + description) via the jira module,
//     1b. asks the two questions that come BEFORE the plan: which of a ticket's
//     subtasks is being planned (`plan_scope`), and — for a BUG — whether this
//     goes out as a hotfix from the hotfix branch, from the ordinary base
//     branch, or from another branch entirely (`plan_hotfix`),
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
	"slash/modules/jira"
	"slash/modules/langpref"
)

const (
	// WorkflowPlan is the Workflow Type of the per-ticket planning tracker.
	WorkflowPlan = "plan"
	// SignalPlanAnswer carries ONE answer of the reviewer: which option of
	// which question, plus the free-text detail typed next to it.
	SignalPlanAnswer = "plan_answer"
	// SignalPlanHotfix answers the question a BUG ticket is asked before the
	// plan is generated: does this go out as a hotfix from the hotfix branch,
	// from the ordinary base branch, or from some other branch entirely?
	SignalPlanHotfix = "plan_hotfix"
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
	// maxPlanQuestionsTotal bounds the questions a plan can grow to over
	// several "meer vragen" rounds (each round itself still adds at most
	// maxPlanQuestions), so the column stays readable.
	maxPlanQuestionsTotal = 15
	// maxPlanRelatedPRs is what "de 3 meest relevante" means: the merged work
	// around this ticket family is only context, so the prompt gets the best
	// three and nothing more (see rankPlanRelatedPRs).
	maxPlanRelatedPRs = 3
	// maxPlanContextIssues bounds how many OTHER issues of the family are read
	// for their comments (each one is its own acli call).
	maxPlanContextIssues = 5
	// maxPlanSearchKeys bounds how many issue keys are searched for merged PRs.
	maxPlanSearchKeys = 8
)

// planAnswerFollowup is the PlanAnswerSignal Kind that asks for MORE questions
// instead of recording an answer. tembed can only WaitSignal on one name at a
// time, so a second kind of message rides on the same Signal with a Kind field
// — the same convention ReactionSignal/PRStateSignal already follow. An empty
// Kind (every signal recorded before this existed) is an ordinary answer.
const planAnswerFollowup = "followup"

// planAnswerChat is the PlanAnswerSignal Kind for a free-form chat message
// about this ticket ("de algemene chat", reused from the review tree — see
// .claude/docs/plan-page.md, "The general chat: keyed on the Jira ticket, not
// a PR"). Text carries the reviewer's message; QuestionID/OptionID are unused
// for this kind, same shape as planAnswerFollowup above.
const planAnswerChat = "chat"

// planAnswerComment is the PlanAnswerSignal Kind the page sends right after a
// reply was posted on a Jira comment (the jira_comment workflow did the actual
// posting — see jira_comment.go): re-read the family's Jira comments onto the
// document and rebuild the task list from them. Reviewer decision: a new
// comment must feed back into the plan, exactly like an answer does. Text and
// QuestionID/OptionID are unused, same shape as the two Kinds above.
const planAnswerComment = "comment"

// planAnswerTask is the PlanAnswerSignal Kind that records the reviewer's own
// bookkeeping on ONE task of the plan (reviewer decision, task 22 of
// todo/plan-page-workflow.md): the CHECKBOX next to it — default on, and
// unchecking it drops the task from the plan AND from every later
// regeneration — plus the free-text FIELD next to it, which travels to the
// execution only. Neither triggers a regeneration: this Kind saves the
// document and nothing else, so typing a note never costs a minutes-long
// Claude call. Text/QuestionID/OptionID are unused; the payload is the
// Task* fields below.
const planAnswerTask = "task"

// maxPlanChatMessages bounds how long the chat transcript on the document is
// allowed to grow (oldest dropped first, always in pairs so a lone orphaned
// reply/question is never left dangling) — the same reasoning as
// maxPlanQuestionsTotal: the prompt and the page both stay bounded.
const maxPlanChatMessages = 40

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
	// Kind is empty for an answer and planAnswerFollowup for "generate follow-up
	// questions so I can sharpen the plan further".
	Kind string `json:"kind,omitempty"`
	// TaskTitle/TaskOff/TaskNote are the planAnswerTask Kind's payload: which
	// task (by its TITLE — see planTaskKey for why not by its id), whether the
	// reviewer unchecked it, and what they typed next to it. TaskID is carried
	// for readability only; nothing matches on it.
	TaskID    string `json:"taskId,omitempty"`
	TaskTitle string `json:"taskTitle,omitempty"`
	TaskOff   bool   `json:"taskOff,omitempty"`
	TaskNote  string `json:"taskNote,omitempty"`
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
	// The concrete half of a task, reviewer request: "elke if statement moet in
	// de plan, elke config ook", plus the checklist agreed with it. Every field
	// is optional and only rendered when the model filled it in — a task that
	// genuinely has no migration says nothing rather than "n.v.t.".
	// Deliberately NO "tests" field: the reviewer does not want the plan to
	// name tests or ask about them (see planPrompt's own rule).
	Location   string   `json:"location,omitempty"`   // module / /app directory
	Conditions []string `json:"conditions,omitempty"` // every if / branch / condition
	Config     []string `json:"config,omitempty"`     // every config, env var, setting
	Migration  string   `json:"migration,omitempty"`  // data migration / schema change
	Endpoints  []string `json:"endpoints,omitempty"`  // new or changed endpoints/routes
	Errors     string   `json:"errors,omitempty"`     // error handling of this step
	Rollout    string   `json:"rollout,omitempty"`    // feature flag / rollout / rollback
	EdgeCases  []string `json:"edgeCases,omitempty"`  // empty, zero, large, several at once
	OutOfScope []string `json:"outOfScope,omitempty"` // explicitly not part of this task
}

// planTaskState is the reviewer's own bookkeeping on ONE task: the checkbox
// (Off — default is CHECKED, so an absent state means "meenemen") and the
// free-text field next to it. Keyed by planTaskKey(title) rather than by the
// task id, because a task id is POSITIONAL (t1..tn, assigned in
// parsePlanAnswer) and every regeneration renumbers the list — an id-keyed
// state would silently jump to a different task. Title keeps the original
// spelling for the prompt.
type planTaskState struct {
	Key   string `json:"key"`
	Title string `json:"title,omitempty"`
	Off   bool   `json:"off,omitempty"`
	Note  string `json:"note,omitempty"`
}

// planComment is one Jira comment reaching the plan: the reviewer asked that
// planning look at "de comments die zijn gegeven in de jira tickets, hoofd en
// sub", because a comment routinely walks the description back. Key names the
// issue it came from (empty means this ticket itself).
type planComment struct {
	Key     string `json:"key,omitempty"`
	Author  string `json:"author,omitempty"`
	Created string `json:"created,omitempty"`
	Body    string `json:"body"`
}

// planRelatedPR is one already-merged pull request around this ticket family —
// the three most relevant ones (see rankPlanRelatedPRs) are context for the
// plan: what already landed, and in which files.
type planRelatedPR struct {
	Number   int    `json:"number"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	MergedAt string `json:"mergedAt,omitempty"`
	// Key is the issue key whose search found this PR — this ticket, its main
	// task, or one of the subtasks — which is also its relevance tier.
	Key   string   `json:"key,omitempty"`
	Files []string `json:"files,omitempty"`
}

// planSubtask is one child issue hanging under this ticket, as shown in the
// scope question.
type planSubtask struct {
	Key    string `json:"key"`
	Title  string `json:"title,omitempty"`
	Status string `json:"status,omitempty"`
	// Assignee/AssigneeAvatarURL name who owns this subtask, both empty when
	// nobody does (the page then shows a circle with a question mark, see
	// .claude/docs/plan-page.md). Jira's own subtasks field carries no
	// assignee, so planLoadIssue pays for one extra search to learn them —
	// explicitly accepted by Reindert as worth its ~2-6s.
	Assignee          string `json:"assignee,omitempty"`
	AssigneeAvatarURL string `json:"assigneeAvatarUrl,omitempty"`
}

// PlanHotfixSignal answers the hotfix question of a bug ticket. Hotfix picks
// the hotfix branch; Branch is the THIRD choice — any other branch the reviewer
// picked from the dropdown — and wins over Hotfix when it is set. Neither set
// means the ordinary base branch.
type PlanHotfixSignal struct {
	Hotfix bool   `json:"hotfix"`
	Branch string `json:"branch,omitempty"`
	// Kind/Text: the same "chat" carve-out plan_answer's Kind already uses
	// (planAnswerChat) — tembed can only WaitSignal on one name at a time,
	// and the general chat about this ticket must keep working regardless of
	// which question the tracker is currently parked on. See handlePlanChat.
	Kind string `json:"kind,omitempty"`
	Text string `json:"text,omitempty"`
}

// PlanScopeSignal answers the scope question. Choice is always "parent" today
// (the only choice that keeps THIS tracker going); it is carried explicitly so
// a later third option does not need a new Signal.
type PlanScopeSignal struct {
	Choice string `json:"choice"`
	// Kind/Text: same chat carve-out as PlanHotfixSignal above.
	Kind string `json:"kind,omitempty"`
	Text string `json:"text,omitempty"`
}

// planAnswer is one stored reviewer answer (the Signal, kept on the document).
type planAnswer struct {
	QuestionID string `json:"questionId"`
	OptionID   string `json:"optionId"`
	Text       string `json:"text,omitempty"`
}

// planChatMessage is one turn of the free-form "algemene chat" about this
// ticket — the review tree's own Claude chat, reused (.claude/docs/
// plan-page.md): Role is "user" (the reviewer) or "assistant" (Claude), Body
// its text. Deliberately NOT the tree's chat.Message (no streaming progress,
// no kind/model/noShell — this is a single blocking Signal + one Claude call,
// not a multi-tool agentic turn), see planChatReply.
type planChatMessage struct {
	Role      string `json:"role"`
	Body      string `json:"body"`
	CreatedAt string `json:"createdAt,omitempty"`
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
	ParentKey         string        `json:"parentKey,omitempty"`
	ParentTitle       string        `json:"parentTitle,omitempty"`
	ParentDescription string        `json:"parentDescription,omitempty"`
	Subtasks          []planSubtask `json:"subtasks,omitempty"`
	// Siblings are the OTHER subtasks of this ticket's main task — context
	// only (never the scope question, which is about this ticket's own
	// children).
	Siblings   []planSubtask `json:"siblings,omitempty"`
	NeedsScope bool          `json:"needsScope,omitempty"`
	// IssueType is the ticket's own kind as Jira names it ("Bug", "Story").
	// AskBase says this Execution asks the base-branch question below at all —
	// set by planLoadIssue, so an older Execution's recorded document lacks it
	// and replays past the gate. Both feed planNeedsBaseQuestion; neither is
	// used for anything else.
	IssueType string `json:"issueType,omitempty"`
	AskBase   bool   `json:"askBase,omitempty"`
	// Assignee/AssigneeAvatarURL name who owns THIS ticket — shown on the
	// ticket card and in the scope question's "de hoofdtaak zelf" choice, also
	// when that is the reviewer himself. Empty means unassigned, which the page
	// spells out (a question-mark circle plus the word), never as a blank.
	Assignee          string `json:"assignee,omitempty"`
	AssigneeAvatarURL string `json:"assigneeAvatarUrl,omitempty"`
	// NeedsHotfix is true while the tracker is parked on the base-branch
	// question every ticket is asked (the mirror of NeedsScope). DefaultBranch and
	// HotfixBranch are the two named choices, carried on the document so the
	// page shows the real branch names instead of hardcoding them; BaseBranch
	// is the ANSWER — the branch this plan is built on and the one
	// plan_execute branches from and opens its draft PR against. Empty means
	// "never asked", which reads as the repo's own base branch.
	// StartsProgress says this Execution moves the ticket to "In Progress" in
	// Jira once that branch question is answered — the reviewer picked a
	// branch, so the work has begun and the row belongs in the planning lane
	// of /pr-overview rather than in its todo lane (Reindert: "als je in todo
	// een branch hebt aangemaakt (eerste vraag), moet het naar in planning en
	// in jira naar in progress"). Like AskBase/LoadsContext it is set by
	// planLoadIssue and therefore ABSENT from every document recorded before
	// the Activity existed, which is what keeps those Executions replaying
	// past the extra call (.claude/rules/workflow-determinism.md).
	StartsProgress bool   `json:"startsProgress,omitempty"`
	NeedsHotfix    bool   `json:"needsHotfix,omitempty"`
	Hotfix         bool   `json:"hotfix,omitempty"`
	BaseBranch     string `json:"baseBranch,omitempty"`
	DefaultBranch  string `json:"defaultBranch,omitempty"`
	HotfixBranch   string `json:"hotfixBranch,omitempty"`
	// Comments are this ticket's own Jira comments; RelatedComments are the
	// ones of the main task and of the subtasks around it, each carrying its
	// own Key. RelatedPRs is the already-merged work of that same family.
	// LoadsContext says this Execution runs the planLoadContext Activity at
	// all: it is set by planLoadIssue, so a document recorded before that
	// Activity existed lacks it and replays past the call — the same
	// positional-history rule AskBase documents above
	// (.claude/rules/workflow-determinism.md).
	Comments        []planComment   `json:"comments,omitempty"`
	RelatedComments []planComment   `json:"relatedComments,omitempty"`
	RelatedPRs      []planRelatedPR `json:"relatedPRs,omitempty"`
	LoadsContext    bool            `json:"loadsContext,omitempty"`
	Questions       []planQuestion  `json:"questions"`
	Tasks           []planTask      `json:"tasks"`
	// TaskStates is the reviewer's checkbox/note per task (see planTaskState).
	// Absent for every document written before task 22 existed, which reads as
	// "every task checked, no notes" — the default.
	TaskStates []planTaskState `json:"taskStates,omitempty"`
	Answers    []planAnswer    `json:"answers"`
	// Chat is the free-form "algemene chat" transcript about this ticket — the
	// review tree's own Claude chat component, reused, but keyed on the Jira
	// KEY (this document) rather than a GitHub PR number: there is no PR yet
	// at planning time. See planChatReply/the plan_answer Kind "chat".
	Chat      []planChatMessage `json:"chat,omitempty"`
	UpdatedAt string            `json:"updatedAt,omitempty"`
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

// handlePlanChat is the ONE body behind every "chat" Kind this workflow can
// receive — the two upfront gates (SignalPlanScope/SignalPlanHotfix) AND the
// main SignalPlanAnswer loop each ride the general chat on their own already-
// waited-on signal (tembed can only WaitSignal on one name at a time), so the
// chat about a ticket keeps working regardless of which question the tracker
// happens to be parked on right now — reviewer request: "die mag je
// hergebruiken" (see .claude/docs/plan-page.md) should not come with the
// caveat "only once every gate is answered". Saves the reviewer's own message
// first (so a poll landing mid-call already shows what was just typed), then
// runs ONE Claude call for the reply and saves again — both their own
// Activity, so a hiccup in the (much slower) Claude call never loses the
// reviewer's own message.
func handlePlanChat(w *tembed.Workflow, doc *planDoc, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	doc.Chat = append(doc.Chat, planChatMessage{Role: "user", Body: text, CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	doc.Chat = trimPlanChat(doc.Chat)
	if err := w.ExecuteActivity("planSave", *doc, nil); err != nil {
		return fmt.Errorf("plan: save chat message: %w", err)
	}
	if err := w.ExecuteActivity("planChatReply", *doc, doc); err != nil {
		return fmt.Errorf("plan: chat reply: %w", err)
	}
	if err := w.ExecuteActivity("planSave", *doc, nil); err != nil {
		return fmt.Errorf("plan: save chat reply: %w", err)
	}
	return nil
}

// handlePlanComments folds a freshly posted Jira comment back into the plan:
// re-read the family's comments (the panel and the prompt then agree on what
// was said) and regenerate the task list from them. Saved before AND after the
// regeneration for the same reason an ordinary answer is: the regeneration is
// a minute-long Claude call, and until it lands the page would otherwise keep
// reading a document that does not know about the comment yet.
//
// The task list is only rebuilt when there IS one — a tracker whose plan has
// not been generated yet reads the same comments in planLoadContext anyway.
func handlePlanComments(w *tembed.Workflow, doc *planDoc) error {
	if err := w.ExecuteActivity("planRefreshComments", *doc, doc); err != nil {
		return fmt.Errorf("plan: refresh comments: %w", err)
	}
	if err := w.ExecuteActivity("planSave", *doc, nil); err != nil {
		return fmt.Errorf("plan: save comments: %w", err)
	}
	if len(doc.Tasks) == 0 {
		return nil
	}
	if err := w.ExecuteActivity("planGenerate", planGenerateArg{Doc: *doc, Mode: "tasks"}, doc); err != nil {
		return fmt.Errorf("plan: regenerate tasks after comment: %w", err)
	}
	if err := w.ExecuteActivity("planSave", *doc, nil); err != nil {
		return fmt.Errorf("plan: save after comment: %w", err)
	}
	return nil
}

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
		// The general chat must keep working while this gate stands (see
		// handlePlanChat's own doc comment) — a chat message rides on the
		// SAME SignalPlanScope wait (Kind "chat"), handled inline, and the
		// tracker simply waits again for the real scope answer.
		for {
			var scope PlanScopeSignal
			w.WaitSignal(SignalPlanScope, &scope)
			if scope.Kind == planAnswerChat {
				if err := handlePlanChat(w, &doc, scope.Text); err != nil {
					return nil, err
				}
				continue
			}
			break
		}
		doc.NeedsScope = false
	}
	// EVERY ticket is asked ONE more thing before anything is generated: does
	// this go out as a hotfix (from the hotfix branch), from the ordinary base
	// branch, or from another branch entirely? Same reasoning as the scope gate
	// above — the answer changes what the plan should contain (a hotfix is kept
	// small and risk-free) and where plan_execute branches from, and
	// planGenerate is a minutes-long Claude call that must not be paid before
	// that is settled.
	//
	// An Execution started before this gate reached its own issue type replays
	// past it untouched — see planNeedsBaseQuestion for why the trigger is read
	// off the RECORDED planLoadIssue result and why planIsBug stays in it
	// (.claude/rules/workflow-determinism.md).
	if planNeedsBaseQuestion(doc) {
		doc.NeedsHotfix = true
		doc.DefaultBranch, doc.HotfixBranch = planDefaultBaseBranch(), planHotfixBranch
		if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
			return nil, fmt.Errorf("plan: save hotfix question: %w", err)
		}
		// Same chat carve-out as the scope gate above.
		var hf PlanHotfixSignal
		for {
			w.WaitSignal(SignalPlanHotfix, &hf)
			if hf.Kind == planAnswerChat {
				if err := handlePlanChat(w, &doc, hf.Text); err != nil {
					return nil, err
				}
				hf = PlanHotfixSignal{}
				continue
			}
			break
		}
		doc.NeedsHotfix = false
		doc.Hotfix, doc.BaseBranch = resolvePlanBase(doc, hf)
		// Answering this question is where the work STARTS: a branch has been
		// chosen, so the ticket moves to "In Progress" in Jira and with it out
		// of /pr-overview's todo lane into its planning lane (see
		// jira_issues.go). Gated on the recorded flag so an Execution from
		// before this Activity existed replays past it untouched. The Activity
		// itself never fails (it logs), because a ticket whose workflow cannot
		// reach that status — or that is already there — must not sink the
		// tracker the reviewer is waiting on.
		if doc.StartsProgress {
			if err := w.ExecuteActivity("jiraStartProgress", doc, nil); err != nil {
				return nil, fmt.Errorf("plan: start progress: %w", err)
			}
		}
	}
	// Everything around the ticket that makes the plan concrete: the Jira
	// comments of the main task and the subtasks, and the already-merged pull
	// requests of that same family (the three most relevant ones). It sits
	// AFTER the gates on purpose — it costs a handful of acli/gh calls, and the
	// page's own start POST must not wait for them; by the time this runs the
	// reviewer has answered a gate and is already waiting on the (minutes-long)
	// generation. Gated on the recorded LoadsContext flag so an Execution from
	// before this Activity existed replays past it untouched.
	if doc.LoadsContext {
		if err := w.ExecuteActivity("planLoadContext", doc, &doc); err != nil {
			return nil, fmt.Errorf("plan: load context: %w", err)
		}
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
		// "Meer vragen om het plan te perfectioneren": generate follow-up
		// questions, APPEND them to the ones already there (the reviewer's
		// stored answers hang off the existing ids, so those may never move),
		// and then rebuild the task list exactly like an answer does. The
		// branch is a pure function of the recorded Signal payload, so replay
		// reproduces it (.claude/rules/workflow-determinism.md).
		if sig.Kind == planAnswerFollowup {
			if err := w.ExecuteActivity("planGenerate", planGenerateArg{Doc: doc, Mode: "followup"}, &doc); err != nil {
				return nil, fmt.Errorf("plan: follow-up questions: %w", err)
			}
			if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
				return nil, fmt.Errorf("plan: save follow-up questions: %w", err)
			}
			if err := w.ExecuteActivity("planGenerate", planGenerateArg{Doc: doc, Mode: "tasks"}, &doc); err != nil {
				return nil, fmt.Errorf("plan: regenerate tasks: %w", err)
			}
			if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
				return nil, fmt.Errorf("plan: save: %w", err)
			}
			continue
		}
		// The reviewer ticked/unticked a task's checkbox, or typed something in
		// the field next to it. Deliberately a save and NOTHING else: the note
		// only travels to plan_execute, and an unchecked task is dropped by
		// mergePlanTasks at the NEXT regeneration (whichever answer triggers
		// it) rather than paying for a minutes-long Claude call per keystroke.
		// A pure fold of the recorded Signal, exactly like upsertPlanAnswer, so
		// replay reproduces it (.claude/rules/workflow-determinism.md).
		if sig.Kind == planAnswerTask {
			doc.TaskStates = upsertPlanTaskState(doc.TaskStates, sig)
			if err := w.ExecuteActivity("planSave", doc, nil); err != nil {
				return nil, fmt.Errorf("plan: save task state: %w", err)
			}
			continue
		}
		// A reply was posted on one of the ticket's Jira comments: re-read them
		// and rebuild the task list (see handlePlanComments).
		if sig.Kind == planAnswerComment {
			if err := handlePlanComments(w, &doc); err != nil {
				return nil, err
			}
			continue
		}
		// The general chat about this ticket (reused from the review tree, see
		// planChatMessage/.claude/docs/plan-page.md) — see handlePlanChat.
		if sig.Kind == planAnswerChat {
			if err := handlePlanChat(w, &doc, sig.Text); err != nil {
				return nil, err
			}
			continue
		}
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

// startJiraProgress is the body of that Activity: move the ticket to "In
// Progress" and nudge the tracker that owns the overview's issue list, so the
// row climbs into its planning lane now rather than at the next 5-minute tick
// (a Signal — never a write of our own, see
// .claude/rules/workflows-write-boundary.md).
//
// Best-effort by design, hence no error: the ways this can fail are all
// "nothing to do" or "not ours to fix" — the ticket is already In Progress, its
// project's workflow has no such transition from where it is, or acli is not
// logged in. None of them are worth failing a plan the reviewer is waiting on;
// the reason is logged and reaches the UI through GET /api/problems.
func (m *TaskManager) startJiraProgress(ctx context.Context, key string) {
	if m == nil || m.jira == nil || key == "" {
		return
	}
	if err := m.jira.Transition(ctx, key, jiraInProgressStatus); err != nil {
		m.logf("plan: %s -> %s: %v", key, jiraInProgressStatus, err)
		return
	}
	if runID := m.EnsureJiraIssues(ctx); runID != "" {
		m.signalJiraIssues(runID, JiraIssuesSignal{Kind: "refresh"})
	}
}

// planNeedsBaseQuestion reports whether this Execution asks which branch the
// plan goes out from. It is a pure function of the RECORDED planLoadIssue
// result, because tembed matches history POSITIONALLY (tembed/workflow.go's
// nthOf): flipping this decision for an Execution that already ran past it
// would shift every later Activity by one and park the tracker on a signal its
// history never carries.
//
//   - askBase is set by planLoadIssue itself and therefore absent from every
//     document recorded before the question applied to all issue types — those
//     Executions keep skipping the gate exactly as their history says.
//   - planIsBug stays in the condition for the mirror image: an Execution
//     started while only a bug was asked HAS the gate in its history, and its
//     recorded document carries the issue type rather than askBase.
//
// A fresh run has both, which is still one gate.
func planNeedsBaseQuestion(doc planDoc) bool {
	return doc.AskBase || planIsBug(doc.IssueType)
}

// planIsBug reports whether Jira's own issue-type name means "a bug" — the
// gate's original trigger, kept for replay (see planNeedsBaseQuestion).
// Matched on the lowercased name containing "bug" so
// "Bug", "Bugfix" and a renamed "Bug (production)" all count; a ticket whose
// type never reached the document (an older Execution, or a Jira read that
// failed) is not a bug and is never asked.
func planIsBug(issueType string) bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(issueType)), "bug")
}

// resolvePlanBase folds the hotfix answer into (hotfix?, base branch) — pure,
// so replay reproduces it exactly. An explicitly picked branch (the dropdown's
// third choice) wins over the hotfix flag; anything unrecognisable falls back
// to the ordinary base branch rather than to a branch that may not exist.
func resolvePlanBase(doc planDoc, sig PlanHotfixSignal) (bool, string) {
	def := doc.DefaultBranch
	if def == "" {
		def = planDefaultBaseBranch()
	}
	hotfix := doc.HotfixBranch
	if hotfix == "" {
		hotfix = planHotfixBranch
	}
	if b := strings.TrimSpace(sig.Branch); b != "" && planBranchRefPattern.MatchString(b) {
		return b == hotfix, b
	}
	if sig.Hotfix {
		return true, hotfix
	}
	return false, def
}

// trimPlanChat bounds the chat transcript to maxPlanChatMessages, dropping
// the OLDEST messages first. Called once right after the reviewer's own
// message is appended (an odd-length list, mid-turn — the reply hasn't
// landed yet) and once more after the reply — a strict "always even" rule
// would be meaningless on the first of those two calls, so this simply caps
// the length; in steady state (every completed turn appends a pair) the kept
// window still starts on a user turn.
func trimPlanChat(list []planChatMessage) []planChatMessage {
	if len(list) <= maxPlanChatMessages {
		return list
	}
	return list[len(list)-maxPlanChatMessages:]
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

// planTaskKey normalizes a task title into the key its checkbox/note state
// hangs off: lowercased, with every whitespace run collapsed to one space.
// Deliberately NOT the task id — ids are positional (t1..tn) and a
// regeneration renumbers the whole list, so an id-keyed state would end up on
// a different task. A title the model rephrases loses its state instead, which
// is the accepted trade-off (see .claude/docs/plan-page.md).
func planTaskKey(title string) string {
	return strings.ToLower(strings.Join(strings.Fields(title), " "))
}

// upsertPlanTaskState folds one planAnswerTask Signal into the state list —
// pure, so replay reproduces it. A state that is both checked and note-less is
// removed again, so the list only ever holds real deviations from the default.
func upsertPlanTaskState(list []planTaskState, sig PlanAnswerSignal) []planTaskState {
	key := planTaskKey(sig.TaskTitle)
	if key == "" {
		return list
	}
	note := strings.TrimSpace(sig.TaskNote)
	out := make([]planTaskState, 0, len(list)+1)
	for _, st := range list {
		if st.Key != key {
			out = append(out, st)
		}
	}
	if !sig.TaskOff && note == "" {
		return out
	}
	return append(out, planTaskState{Key: key, Title: strings.TrimSpace(sig.TaskTitle), Off: sig.TaskOff, Note: note})
}

// planTaskStateFor looks up one task's state; the zero value is the default
// (checked, no note).
func planTaskStateFor(states []planTaskState, title string) planTaskState {
	key := planTaskKey(title)
	for _, st := range states {
		if st.Key == key {
			return st
		}
	}
	return planTaskState{}
}

// planTaskEnabled reports whether a task is still part of the plan. Default is
// TRUE: a document written before task 22 (and every task the reviewer never
// touched) carries no state at all.
func planTaskEnabled(states []planTaskState, title string) bool {
	return !planTaskStateFor(states, title).Off
}

// mergePlanTasks is what makes "uitvinken laat de taak ook uit de hergeneratie
// verdwijnen" hold: a freshly generated list keeps only the tasks the reviewer
// did NOT uncheck, and the unchecked ones are re-appended from the PREVIOUS
// list so their row (and its checkbox) stays on the page and can be ticked
// again. Ids are renumbered across the result, since they are positional
// anyway. Pure, so the Activity's recorded result replays identically.
func mergePlanTasks(fresh, prev []planTask, states []planTaskState) []planTask {
	out := make([]planTask, 0, len(fresh)+len(prev))
	for _, tk := range fresh {
		if planTaskEnabled(states, tk.Title) {
			out = append(out, tk)
		}
	}
	seen := make(map[string]bool, len(out))
	for _, tk := range out {
		seen[planTaskKey(tk.Title)] = true
	}
	for _, tk := range prev {
		key := planTaskKey(tk.Title)
		if planTaskEnabled(states, tk.Title) || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, tk)
	}
	for i := range out {
		out[i].ID = fmt.Sprintf("t%d", i+1)
	}
	return out
}

// planDisabledTaskTitles lists the tasks the reviewer unchecked, in the order
// they were unchecked — what planPrompt tells the model to leave out.
func planDisabledTaskTitles(states []planTaskState) []string {
	out := make([]string, 0, len(states))
	for _, st := range states {
		if st.Off && strings.TrimSpace(st.Title) != "" {
			out = append(out, st.Title)
		}
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

// fillPlanSubtaskAssignees fills the Assignee/AssigneeAvatarURL of every
// subtask and sibling row IN PLACE, from one extra Jira search over their keys
// (jira.IssuesByKey). Jira's parent/subtasks link carries no assignee, so
// there is no cheaper source; the cost — one `acli` call of a few seconds per
// planLoadIssue — was weighed and accepted, because the scope question is
// exactly where the reviewer decides based on who owns what.
//
// Best-effort by design: a failure (acli hiccup, no client) is logged and
// leaves the rows as they were, which reads as "unassigned" and is never worse
// than not showing the question at all. Both lists are handled in ONE call.
func fillPlanSubtaskAssignees(ctx context.Context, m *TaskManager, key string, lists ...[]planSubtask) {
	if m == nil || m.jira == nil {
		return
	}
	var keys []string
	for _, list := range lists {
		for _, st := range list {
			if st.Key != "" {
				keys = append(keys, st.Key)
			}
		}
	}
	if len(keys) == 0 {
		return
	}
	found, err := m.jira.IssuesByKey(ctx, keys)
	if err != nil {
		m.logf("plan: assignees of %s subtasks: %v", key, err)
		return
	}
	byKey := make(map[string]jira.Issue, len(found))
	for _, is := range found {
		byKey[is.Key] = is
	}
	for _, list := range lists {
		for i := range list {
			if is, ok := byKey[list[i].Key]; ok {
				list[i].Assignee, list[i].AssigneeAvatarURL = is.Assignee, is.AssigneeAvatarURL
			}
		}
	}
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
		doc.IssueType = issue.Type
		doc.Assignee, doc.AssigneeAvatarURL = issue.Assignee, issue.AssigneeAvatarURL
		// Only once the ticket really was read: a document that failed to load
		// has no plan to build either way, and parking it on a branch question
		// would ask for nothing.
		doc.AskBase = true
		// Same rule for the "move it to In Progress" Activity behind that
		// question: only a document that really loaded runs it.
		doc.StartsProgress = true
		// Context loading (comments of the family, merged PRs) only makes sense
		// once the ticket really was read; the flag is what keeps an older
		// Execution replaying past that Activity.
		doc.LoadsContext = true
		for _, c := range issue.Comments {
			doc.Comments = append(doc.Comments, planComment{Author: c.Author, Created: c.Created, Body: c.Body})
		}
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
				for _, c := range parent.Comments {
					doc.RelatedComments = append(doc.RelatedComments, planComment{
						Key: doc.ParentKey, Author: c.Author, Created: c.Created, Body: c.Body,
					})
				}
				// A subtask's SIBLINGS are the parent's other children: the
				// same family the merged-PR search and the comment sweep below
				// walk (the ticket itself already knows its own children).
				for _, st := range parent.Subtasks {
					if st.Key != "" && st.Key != doc.Key {
						doc.Siblings = append(doc.Siblings, planSubtask{Key: st.Key, Title: st.Title, Status: st.Status})
					}
				}
			}
		}
		// The scope question offers the subtasks by name, and the reviewer
		// wants to see WHO owns each one before picking (Reindert, task 24) —
		// but Jira's subtasks field carries no assignee at all, so this is one
		// extra `key in (…)` search over exactly the keys we already have. One
		// call for both lists, inside this same Activity: adding an Activity of
		// its own would break the replay of every existing plan-<KEY> Execution
		// (.claude/rules/workflow-determinism.md). Best-effort — a failure
		// leaves the rows without an assignee, never sinks the tracker.
		fillPlanSubtaskAssignees(ctx, m, arg.Key, doc.Subtasks, doc.Siblings)
		return json.Marshal(doc)
	})
	// Activity: everything around the ticket that makes the plan concrete —
	// the Jira comments of the OTHER issues in the family (the main task's own
	// comments already came back with the parent read in planLoadIssue) and the
	// merged pull requests of that family, ranked down to the three most
	// relevant (see plan_context.go). Best-effort throughout: a missing gh or a
	// Jira hiccup costs context, never the tracker.
	engine.RegisterActivity("planLoadContext", func(ctx context.Context, in []byte) ([]byte, error) {
		var doc planDoc
		if err := json.Unmarshal(in, &doc); err != nil {
			return nil, err
		}
		keys := planRelatedKeys(doc)
		// The comments of the subtasks/siblings — one acli call each, so
		// bounded. This ticket's own and its main task's comments are already
		// on the document.
		if m.jira != nil {
			read := 0
			for _, key := range keys {
				if key == doc.Key || key == strings.ToUpper(doc.ParentKey) || read >= maxPlanContextIssues {
					continue
				}
				read++
				issue, err := m.jira.Issue(ctx, key)
				if err != nil {
					m.logf("plan: context comments %s of %s: %v", key, doc.Key, err)
					continue
				}
				for _, c := range issue.Comments {
					doc.RelatedComments = append(doc.RelatedComments, planComment{
						Key: key, Author: c.Author, Created: c.Created, Body: c.Body,
					})
				}
			}
		}
		found := make([]planRelatedPR, 0, 8)
		for _, key := range keys {
			found = append(found, searchMergedPRs(ctx, key)...)
		}
		doc.RelatedPRs = rankPlanRelatedPRs(found, keys)
		for i := range doc.RelatedPRs {
			doc.RelatedPRs[i].Files = prChangedFiles(ctx, doc.RelatedPRs[i].Number)
		}
		return json.Marshal(doc)
	})
	// Activity: re-read the family's Jira comments onto the document, after the
	// reviewer replied to one of them (see handlePlanComments). Same reads as
	// planLoadIssue/planLoadContext do at start-up, bounded the same way, and
	// REPLACING both lists rather than appending — a re-read must not duplicate
	// what is already there. Best-effort per issue: one unreachable ticket
	// costs its comments, never the tracker.
	engine.RegisterActivity("planRefreshComments", func(ctx context.Context, in []byte) ([]byte, error) {
		var doc planDoc
		if err := json.Unmarshal(in, &doc); err != nil {
			return nil, err
		}
		if m.jira == nil {
			return json.Marshal(doc)
		}
		doc.Comments = nil
		doc.RelatedComments = nil
		if issue, err := m.jira.Issue(ctx, doc.Key); err != nil {
			m.logf("plan: refresh comments %s: %v", doc.Key, err)
		} else {
			for _, c := range issue.Comments {
				doc.Comments = append(doc.Comments, planComment{Author: c.Author, Created: c.Created, Body: c.Body})
			}
		}
		read := 0
		for _, key := range planRelatedKeys(doc) {
			if key == strings.ToUpper(doc.Key) || read >= maxPlanContextIssues {
				continue
			}
			read++
			issue, err := m.jira.Issue(ctx, key)
			if err != nil {
				m.logf("plan: refresh comments %s of %s: %v", key, doc.Key, err)
				continue
			}
			for _, c := range issue.Comments {
				doc.RelatedComments = append(doc.RelatedComments, planComment{
					Key: key, Author: c.Author, Created: c.Created, Body: c.Body,
				})
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
		switch arg.Mode {
		case "all":
			doc.Questions = qs
		case "followup":
			// APPEND: the reviewer's stored answers hang off the existing ids,
			// so those questions may never move or be renumbered. The task list
			// that came back with a follow-up round is ignored here — the
			// workflow regenerates it in its own step right after, from the
			// document that now holds the new questions.
			doc.Questions = appendPlanQuestions(doc.Questions, qs)
			return json.Marshal(doc)
		}
		// The reviewer's unchecked tasks never come back (and their rows stay
		// visible so they can be ticked again) — see mergePlanTasks.
		doc.Tasks = mergePlanTasks(tasks, doc.Tasks, doc.TaskStates)
		return json.Marshal(doc)
	})
	// Activity: ONE Claude call answering the reviewer's latest chat message
	// (the general chat about this ticket — reused from the review tree, see
	// planChatMessage/.claude/docs/plan-page.md). Unlike planGenerate this is
	// plain prose, not a JSON object, and it never touches Questions/Tasks —
	// the chat is a side conversation next to the plan, not another way to
	// edit it. Best-effort: a hiccup (or SLASH_CLAUDE=off) still appends an
	// assistant turn saying so, exactly like the tree's own failed-turn
	// bubbles, rather than leaving the reviewer's own message unanswered
	// forever.
	engine.RegisterActivity("planChatReply", func(ctx context.Context, in []byte) ([]byte, error) {
		var doc planDoc
		if err := json.Unmarshal(in, &doc); err != nil {
			return nil, err
		}
		now := time.Now().UTC().Format(time.RFC3339)
		doc.UpdatedAt = now
		if m.claude == nil {
			doc.Chat = append(doc.Chat, planChatMessage{Role: "assistant", Body: "Claude is nu niet beschikbaar.", CreatedAt: now})
			doc.Chat = trimPlanChat(doc.Chat)
			return json.Marshal(doc)
		}
		raw, err := m.claude.Run(ctx, claude.RunRequest{
			Model:  claude.ModelSonnet,
			Prompt: planChatPrompt(doc) + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
		})
		reply := strings.TrimSpace(raw)
		if err != nil || reply == "" {
			if err != nil {
				m.logf("plan: chat reply %s: %v", doc.Key, err)
			}
			reply = "Kon geen antwoord genereren, probeer het opnieuw."
		}
		doc.Chat = append(doc.Chat, planChatMessage{Role: "assistant", Body: reply, CreatedAt: now})
		doc.Chat = trimPlanChat(doc.Chat)
		return json.Marshal(doc)
	})
	// Activity: persist the document (write, workflow-driven).
	//
	// It also writes the three planning-phase artifacts (intent.md → spec.md →
	// plan.md, see plan_artifacts.go). Deliberately HERE rather than as an
	// Activity of its own in the workflow body: the plan Run ID is
	// deterministic, tembed matches history positionally, and an extra
	// ExecuteActivity would park every existing Execution on a step its
	// history does not carry (.claude/rules/workflow-determinism.md). planSave
	// is already called at exactly the moments a phase advances — after the
	// issue loaded, after a gate, after every generation — so riding along
	// inside it needs no replay flag at all. Best-effort: the files are
	// derived from the document that was JUST stored, so a disk hiccup costs a
	// regenerable file, never the plan the reviewer is waiting on.
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
		if err := m.plan.Save(ctx, doc.Key, string(raw), doc.UpdatedAt); err != nil {
			return nil, err
		}
		if _, err := writePlanArtifacts(m.dataDir, doc); err != nil {
			m.logf("plan: write artifacts %s: %v", doc.Key, err)
		}
		return nil, nil
	})

	// Activity: the ticket moves to "In Progress" in Jira, now that the
	// reviewer answered which branch the plan goes out from. The one WRITE
	// into Jira this tracker does (per
	// .claude/rules/workflows-write-boundary.md a module write lives in an
	// Activity, never in a handler), and deliberately BEST-EFFORT: it returns
	// no error, because the reasons it can fail are all "nothing to do" or
	// "not ours to fix" — the ticket is already In Progress, its project's
	// workflow has no such transition from where it is, or acli is not logged
	// in — and none of them are worth failing a plan the reviewer is waiting
	// for. The failure is logged and reaches the UI through GET /api/problems.
	engine.RegisterActivity("jiraStartProgress", func(ctx context.Context, in []byte) ([]byte, error) {
		var doc planDoc
		if err := json.Unmarshal(in, &doc); err != nil {
			return nil, err
		}
		m.startJiraProgress(ctx, doc.Key)
		return nil, nil
	})
}
