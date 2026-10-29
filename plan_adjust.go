package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/reindert-vetter/tembed"
)

// The plan page adjusts an existing plan instead of rebuilding it. A new
// answer / Jira comment / topic edit used to restart a ~3.5 minute full
// regeneration, so five answers in a row meant five of them, four of which were
// thrown away. Now:
//
//   - planGenerate in Mode "adjust" gets the CURRENT plan plus what changed and
//     answers with a handful of ops (add / update / remove a task). The ops are
//     applied deterministically by applyPlanOps: ticked tasks, the reviewer's
//     notes and the order stay as they are. The model may itself say
//     "fullRevision": the workflow then runs the ordinary full "tasks" call.
//   - A change that arrives while a generation runs (planChangeSignals) cancels
//     it, and a generation that starts while one is already waiting in the
//     history skips itself (planPendingChangeSignals) — so the waiting changes
//     are folded into the document one by one and ONE generation covers them
//     all. Both outcomes are the recorded result of the Activity
//     (planDoc.GenOutcome), never a live decision of the workflow body, so
//     replay stays deterministic (.claude/rules/workflow-determinism.md).
//
// See "Adjust, abort and merge" in .claude/docs/plan-page.md.

// planGenOutcome values, carried on planDoc.GenOutcome by the planGenerate
// Activity (an empty value is an ordinary success or error).
const (
	// planGenAborted: the Activity did not (finish) its Claude call because a
	// plan-changing signal is waiting in the history. The document is returned
	// as it came in.
	planGenAborted = "aborted"
	// planGenRevise: an adjust call said the plan needs a full revision.
	planGenRevise = "revise"
)

// planChangeKind is true for the signal Kinds that change what the plan should
// say: an answer (empty Kind), a new Jira comment and a topic edit. A chat
// question or a ticked task changes nothing in the plan, so those never abort.
func planChangeKind(kind string) bool {
	return kind == "" || kind == planAnswerComment || kind == planAnswerTopic
}

// planPendingChangeSignals counts the plan-changing signals on SignalPlanAnswer
// the tracker has recorded but not consumed yet: seen is doc.AnswersSeen, the
// number of SignalPlanAnswer signals the workflow body has consumed (it counts
// them itself, so this is a pure function of document + history).
func planPendingChangeSignals(hist []tembed.Event, seen int) int {
	n, idx := 0, 0
	for _, ev := range hist {
		if ev.Type != tembed.EventSignalReceived || ev.Name != SignalPlanAnswer {
			continue
		}
		idx++
		if idx <= seen {
			continue
		}
		var sig struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(ev.Payload, &sig) == nil && planChangeKind(sig.Kind) {
			n++
		}
	}
	return n
}

// planChangeSignals counts, per ticket key, the plan-changing signals the HTTP
// layer delivered since the process started. A running planGenerate watches its
// own key's counter to notice "something new arrived" without re-reading the
// (large) history. In-memory and operational only — a wake-up, never the source
// of truth (the history is), see .claude/rules/workflows-write-boundary.md.
var planChangeSignals sync.Map // key -> *atomic.Int64

func planChangeCounter(key string) *atomic.Int64 {
	v, _ := planChangeSignals.LoadOrStore(key, new(atomic.Int64))
	return v.(*atomic.Int64)
}

// notePlanChangeSignal is called by the signal endpoint AFTER the signal was
// recorded.
func notePlanChangeSignal(key, kind string) {
	if planChangeKind(kind) {
		planChangeCounter(key).Add(1)
	}
}

// planRawTask is one task as the model writes it (generate and adjust alike).
type planRawTask struct {
	Title       string      `json:"title"`
	Explanation string      `json:"explanation"`
	Blocks      []planBlock `json:"blocks"`
	Location    string      `json:"location"`
	Conditions  []string    `json:"conditions"`
	Config      []string    `json:"config"`
	Migration   string      `json:"migration"`
	Endpoints   []string    `json:"endpoints"`
	Errors      string      `json:"errors"`
	Rollout     string      `json:"rollout"`
	EdgeCases   []string    `json:"edgeCases"`
	OutOfScope  []string    `json:"outOfScope"`
}

// toTask normalizes one raw task (trim, caps) under the given id.
func (tk planRawTask) toTask(id string) planTask {
	return planTask{
		ID:          id,
		Title:       strings.TrimSpace(tk.Title),
		Explanation: strings.TrimSpace(tk.Explanation),
		Blocks:      normalizePlanBlocks(tk.Blocks),
		Location:    planTrim(tk.Location, maxPlanDetailLen),
		Conditions:  normalizePlanDetails(tk.Conditions),
		Config:      normalizePlanDetails(tk.Config),
		Migration:   planTrim(tk.Migration, maxPlanDetailLen),
		Endpoints:   normalizePlanDetails(tk.Endpoints),
		Errors:      planTrim(tk.Errors, maxPlanDetailLen),
		Rollout:     planTrim(tk.Rollout, maxPlanDetailLen),
		EdgeCases:   normalizePlanDetails(tk.EdgeCases),
		OutOfScope:  normalizePlanDetails(tk.OutOfScope),
	}
}

// planOp is one change of an adjust answer.
type planOp struct {
	Op    string       `json:"op"`    // add | update | remove
	Title string       `json:"title"` // the existing task (update/remove)
	After string       `json:"after"` // add: insert after this task's title; empty = at the end
	Task  *planRawTask `json:"task"`  // add: the new task; update: the fields to change
}

type planOpsAnswer struct {
	Ops          []planOp `json:"ops"`
	FullRevision bool     `json:"fullRevision"`
	Reason       string   `json:"reason"`
}

// parsePlanOps extracts the ops answer out of the model's raw text.
func parsePlanOps(raw string) (planOpsAnswer, error) {
	var ans planOpsAnswer
	body := planJSONObject(raw)
	if body == "" {
		return ans, fmt.Errorf("plan: no JSON object in the model's answer")
	}
	if err := json.Unmarshal([]byte(body), &ans); err != nil {
		return ans, fmt.Errorf("plan: parse ops: %w", err)
	}
	return ans, nil
}

// applyPlanOps folds an adjust answer into the task list — pure. Everything the
// reviewer owns is left alone: a task they unchecked is neither updated nor
// removed nor re-added (it stays out of the plan, its row stays on the page),
// notes and checkboxes hang off the title and follow a renamed task, and the
// order of the existing tasks never changes (an add lands after its anchor or at
// the end). An op that does not fit (unknown title, a duplicate add) is skipped,
// not an error. Returns the new list, the states, and the number of ops applied.
func applyPlanOps(tasks []planTask, states []planTaskState, ops []planOp) ([]planTask, []planTaskState, int) {
	out := append([]planTask(nil), tasks...)
	st := append([]planTaskState(nil), states...)
	find := func(title string) int {
		key := planTaskKey(title)
		if key == "" {
			return -1
		}
		for i, tk := range out {
			if planTaskKey(tk.Title) == key {
				return i
			}
		}
		return -1
	}
	applied := 0
	for _, op := range ops {
		switch op.Op {
		case "remove":
			i := find(op.Title)
			if i < 0 || !planTaskEnabled(st, out[i].Title) {
				continue
			}
			out = append(out[:i], out[i+1:]...)
			applied++
		case "update":
			i := find(op.Title)
			if i < 0 || op.Task == nil || !planTaskEnabled(st, out[i].Title) {
				continue
			}
			next := mergeRawIntoTask(out[i], *op.Task)
			if planTaskKey(next.Title) != planTaskKey(out[i].Title) {
				if find(next.Title) >= 0 {
					next.Title = out[i].Title // would collide with another task
				} else {
					for j := range st {
						if st[j].Key == planTaskKey(out[i].Title) {
							st[j].Key, st[j].Title = planTaskKey(next.Title), next.Title
						}
					}
				}
			}
			out[i] = next
			applied++
		case "add":
			if op.Task == nil || strings.TrimSpace(op.Task.Title) == "" || len(out) >= maxPlanTasks {
				continue
			}
			nt := op.Task.toTask("")
			if find(nt.Title) >= 0 || !planTaskEnabled(st, nt.Title) {
				continue
			}
			at := len(out)
			if a := find(op.After); a >= 0 {
				at = a + 1
			}
			out = append(out, planTask{})
			copy(out[at+1:], out[at:])
			out[at] = nt
			applied++
		}
	}
	for i := range out {
		out[i].ID = fmt.Sprintf("t%d", i+1)
	}
	return out, st, applied
}

// mergeRawIntoTask overlays the non-empty fields of an update onto a task.
func mergeRawIntoTask(tk planTask, raw planRawTask) planTask {
	up := raw.toTask(tk.ID)
	if up.Title != "" {
		tk.Title = up.Title
	}
	if up.Explanation != "" {
		tk.Explanation = up.Explanation
	}
	if len(up.Blocks) > 0 {
		tk.Blocks = up.Blocks
	}
	if up.Location != "" {
		tk.Location = up.Location
	}
	if len(up.Conditions) > 0 {
		tk.Conditions = up.Conditions
	}
	if len(up.Config) > 0 {
		tk.Config = up.Config
	}
	if up.Migration != "" {
		tk.Migration = up.Migration
	}
	if len(up.Endpoints) > 0 {
		tk.Endpoints = up.Endpoints
	}
	if up.Errors != "" {
		tk.Errors = up.Errors
	}
	if up.Rollout != "" {
		tk.Rollout = up.Rollout
	}
	if len(up.EdgeCases) > 0 {
		tk.EdgeCases = up.EdgeCases
	}
	if len(up.OutOfScope) > 0 {
		tk.OutOfScope = up.OutOfScope
	}
	return tk
}

// planAnswersChangedSince lists the answers in cur that are new or different
// compared to the set the plan was last generated from.
func planAnswersChangedSince(planned, cur []planAnswer) []planAnswer {
	var out []planAnswer
	for _, a := range cur {
		same := false
		for _, p := range planned {
			if p == a {
				same = true
				break
			}
		}
		if !same {
			out = append(out, a)
		}
	}
	return out
}

// planAdjustPrompt asks for ops against the current plan. The plan is shown
// compactly (no example code — the model is not asked to repeat it), so both
// the prompt and the answer stay small.
func planAdjustPrompt(doc planDoc) string {
	var b strings.Builder
	b.WriteString("Je past een bestaand uitvoerplan aan voor een Jira-ticket. Je stelt het plan NIET opnieuw op: je geeft alleen de wijzigingen.\n\n")
	writePlanContext(&b, doc)
	writePlanChatTranscript(&b, doc, "GESPREK MET DE REVIEWER OVER DIT TICKET (wat hier is afgesproken weegt zwaarder dan de omschrijving):")
	if changed := planAnswersChangedSince(doc.PlannedAnswers, doc.Answers); len(changed) > 0 {
		b.WriteString("NIEUW OF GEWIJZIGD SINDS HET PLAN LAATST WERD OPGESTELD (verwerk deze in het plan):\n")
		for _, a := range changed {
			q, opt := planLookupAnswer(doc, a)
			fmt.Fprintf(&b, "- %s → %s", q, opt)
			if a.Text != "" {
				fmt.Fprintf(&b, " (toelichting: %s)", a.Text)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("HET HUIDIGE PLAN:\n")
	for _, tk := range doc.Tasks {
		state := planTaskStateFor(doc.TaskStates, tk.Title)
		mark := ""
		if state.Off {
			mark = " [UITGEVINKT door de reviewer: laat deze taak met rust]"
		}
		fmt.Fprintf(&b, "- %q%s\n", tk.Title, mark)
		if tk.Explanation != "" {
			fmt.Fprintf(&b, "    uitleg: %s\n", planTrim(tk.Explanation, 400))
		}
		if tk.Location != "" {
			fmt.Fprintf(&b, "    locatie: %s\n", tk.Location)
		}
		for _, c := range tk.Conditions {
			fmt.Fprintf(&b, "    voorwaarde: %s\n", planTrim(c, 160))
		}
		for _, bl := range tk.Blocks {
			fmt.Fprintf(&b, "    voorbeeldcode: %s\n", bl.Title)
		}
	}
	b.WriteString("\nAntwoord met UITSLUITEND één JSON-object, zonder tekst eromheen en zonder code-fence:\n")
	b.WriteString(`{"ops":[{"op":"add","after":"<titel van de taak waarna dit komt, leeg = achteraan>","task":{"title":"…","explanation":"…","location":"…","conditions":["…"],"blocks":[{"title":"…","lang":"php","note":"…","code":"…","children":[]}]}},`)
	b.WriteString(`{"op":"update","title":"<exacte titel van een bestaande taak>","task":{"explanation":"…"}},{"op":"remove","title":"<exacte titel van een bestaande taak>"}],"fullRevision":false,"reason":"…"}`)
	b.WriteString("\n\nRegels:\n")
	b.WriteString("- Geef ALLEEN de wijzigingen die de nieuwe informatie echt nodig maakt. Verandert er niets aan het plan, antwoord dan met een lege \"ops\"-lijst.\n")
	b.WriteString("- \"update\": zet in \"task\" alleen de velden die veranderen (title, explanation, location, conditions, config, migration, endpoints, errors, rollout, edgeCases, outOfScope, blocks); wat je weglaat blijft zoals het is. Een lijst-veld dat je meegeeft vervangt de hele lijst.\n")
	b.WriteString("- \"title\" bij update/remove en \"after\" bij add zijn de EXACTE titels uit het huidige plan.\n")
	fmt.Fprintf(&b, "- Het plan heeft maximaal %d taken. Een nieuwe taak is net zo concreet als de bestaande (locatie, voorwaarden, config, randgevallen waar van toepassing) en krijgt voorbeeldcode van hooguit ~12 regels per blok met een \"note\".\n", maxPlanTasks)
	b.WriteString("- Taken met [UITGEVINKT …] raak je niet aan en je voegt ze niet opnieuw toe.\n")
	b.WriteString("- Geen onderzoekstaken en geen taken die afhangen van de uitkomst van een andere taak. Noem GEEN tests.\n")
	b.WriteString("- Is het plan door de nieuwe informatie zo veranderd dat aanpassen niet meer volstaat (het meeste moet anders), zet dan \"fullRevision\" op true en laat \"ops\" leeg: het plan wordt dan volledig opnieuw opgesteld.\n")
	b.WriteString("- Prozateksten in het Nederlands, code en identifiers in het Engels. Geldige JSON: elk dubbel aanhalingsteken en elke newline binnen een tekst-/code-waarde correct ge-escaped, geen komma vlak voor een sluitende } of ].\n")
	return b.String()
}

// planSalvageTruncated repairs an answer the model's output limit cut off
// mid-way: it keeps everything up to the last COMPLETE element of a top-level
// array (the tasks) and closes the object again. Returns "" when nothing
// complete is there to keep. A string-aware scan, no parsing of the content.
func planSalvageTruncated(body string) string {
	start := strings.Index(body, "{")
	if start < 0 {
		return ""
	}
	var stack []byte
	inStr, esc := false, false
	last := -1
	for i := start; i < len(body); i++ {
		c := body[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{', '[':
			stack = append(stack, c)
		case '}', ']':
			if len(stack) == 0 {
				return ""
			}
			stack = stack[:len(stack)-1]
			// A '}' that closes an element directly inside a top-level array.
			if c == '}' && len(stack) == 2 && stack[1] == '[' {
				last = i
			}
		}
	}
	if len(stack) == 0 || last < 0 {
		return ""
	}
	return body[start:last+1] + "]}"
}
