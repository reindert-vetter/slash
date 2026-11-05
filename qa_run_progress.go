// qa_run_progress.go — "what is the QA run doing right now" for one PR's
// running qa_run: a purely in-memory snapshot, updated from the streamed CLI
// events plus the run's own `[slash:qa-plan]`/`[slash:qa-step]` lines
// (qa_run.go), pushed to the browser over SSE (eventQAProgress) and readable
// via GET /api/qa (its resync read).
//
// Same carve-out from .claude/rules/workflows-write-boundary.md as
// test_run_progress.go: no module, no read-model, no workflow-history write,
// empty again after a restart. Never the source of truth — the finished QA
// report is the qa_run run's own recorded result.
package main

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// qaRunProgress is the volatile state of one PR's QA run. Phase/Tool/Detail
// are named exactly like chatProgress's, so the frontend reuses
// claudeStatusText (src/ClaudeChat.mjs) for the status line.
type qaRunProgress struct {
	RunID   string   `json:"runId,omitempty"`
	Running bool     `json:"running"`
	Plan    string   `json:"plan,omitempty"`
	Steps   []string `json:"steps"` // every [slash:qa-step] title, in order
	// Todos is the step checklist Claude announces up front
	// ([slash:qa-todo]) and ticks off while it works ([slash:qa-doing] /
	// [slash:qa-done]); see applyQAMarker.
	Todos  []qaTodo `json:"todos"`
	Phase  string   `json:"phase"`
	Tool   string   `json:"tool,omitempty"`
	Detail string   `json:"detail,omitempty"`
	// WaitingChoice: the run is blocked on the PR's open werkmap choice (the
	// same chatCheckoutDecision a chat turn raises); the page shows the werkmap
	// overlay meanwhile and the run continues by itself once it is answered.
	WaitingChoice bool   `json:"waitingChoice,omitempty"`
	Cancelled     bool   `json:"cancelled,omitempty"`
	Error         string `json:"error,omitempty"`
	StartedAt     int64  `json:"startedAt"`
	UpdatedAt     int64  `json:"updatedAt"`
}

var (
	qaRunMu   sync.Mutex
	qaRunByPR = map[prKey]qaRunProgress{}
)

func startQARunProgress(repo string, pr int, runID string) {
	now := nowMillis()
	p := qaRunProgress{RunID: runID, Running: true, Phase: chatPhasePreparing, Steps: []string{}, Todos: []qaTodo{}, StartedAt: now, UpdatedAt: now}
	qaRunMu.Lock()
	qaRunByPR[prKey{repo, pr}] = p
	qaRunMu.Unlock()
	publishQARunProgress(repo, pr, p)
}

// mutateQARunProgress applies fn and publishes the result; a PR without a
// snapshot is left alone.
func mutateQARunProgress(repo string, pr int, fn func(*qaRunProgress)) {
	qaRunMu.Lock()
	p, ok := qaRunByPR[prKey{repo, pr}]
	if ok {
		fn(&p)
		p.UpdatedAt = nowMillis()
		qaRunByPR[prKey{repo, pr}] = p
	}
	qaRunMu.Unlock()
	if ok {
		publishQARunProgress(repo, pr, p)
	}
}

func finishQARunProgress(repo string, pr int) {
	mutateQARunProgress(repo, pr, func(p *qaRunProgress) {
		p.Running = false
		p.WaitingChoice = false
		p.Phase, p.Tool, p.Detail = "", "", ""
	})
}

func qaRunProgressFor(repo string, pr int) (qaRunProgress, bool) {
	qaRunMu.Lock()
	defer qaRunMu.Unlock()
	p, ok := qaRunByPR[prKey{repo, pr}]
	return p, ok
}

// qaRunRunning guards POST /api/workflows/qa_run: one QA run per PR at a time
// (it drives the one local stack and the PR's one checkout).
func qaRunRunning(repo string, pr int) bool {
	p, ok := qaRunProgressFor(repo, pr)
	return ok && p.Running
}

func publishQARunProgress(repo string, pr int, p qaRunProgress) {
	events.publish(eventQAProgress, repo, pr, "", p)
}

// qaTodo is one row of the live step checklist. Added marks a step that came
// in after work started (the first [slash:qa-doing]), i.e. inserted between
// or after the up-front plan.
type qaTodo struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	State  string `json:"state"`            // todo | doing | done
	Result string `json:"result,omitempty"` // ok | warn | fail | skip (done only)
	Added  bool   `json:"added,omitempty"`
}

const (
	qaMaxTodos     = 60
	qaMaxTodoTitle = 200
)

var (
	qaTodoIDRe   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,12}$`)
	qaTodoHeadRe = regexp.MustCompile(`^([A-Za-z0-9._-]{1,12})(?:[ \t]+na[ \t]+([A-Za-z0-9._-]{1,12}))?$`)
)

// applyQAMarker applies one parsed progress marker (kind without the
// "slash:" prefix, text = the rest of the line) to the snapshot:
//
//	qa-plan  <line>                  the one-line plan summary
//	qa-todo  <id> | <title>          add a planned step at the end (known id: retitle)
//	qa-todo  <id> na <other> | <t>   insert right after <other> (unknown: at the end)
//	qa-doing <id>                    mark in progress; a previous doing step becomes done
//	qa-done  <id> [ok|warn|fail|skip]
//	qa-step  <title>                 legacy: an ad-hoc step, appended as doing
func applyQAMarker(p *qaRunProgress, kind, text string) {
	text = strings.TrimSpace(text)
	switch kind {
	case "qa-plan":
		p.Plan = truncateTestRunText(text, qaMaxTodoTitle)
	case "qa-todo":
		head, title, ok := strings.Cut(text, "|")
		if !ok {
			return
		}
		m := qaTodoHeadRe.FindStringSubmatch(strings.TrimSpace(head))
		title = truncateTestRunText(strings.TrimSpace(title), qaMaxTodoTitle)
		if m == nil || title == "" {
			return
		}
		if i := qaTodoIndex(p, m[1]); i >= 0 {
			p.Todos[i].Title = title
			return
		}
		if len(p.Todos) >= qaMaxTodos {
			return
		}
		t := qaTodo{ID: m[1], Title: title, State: "todo", Added: qaWorkStarted(p)}
		at := len(p.Todos)
		if m[2] != "" {
			if i := qaTodoIndex(p, m[2]); i >= 0 {
				at = i + 1
			}
		}
		p.Todos = append(p.Todos, qaTodo{})
		copy(p.Todos[at+1:], p.Todos[at:])
		p.Todos[at] = t
	case "qa-doing":
		id := strings.Fields(text + " ")[0]
		i := qaTodoIndex(p, id)
		if i < 0 {
			return
		}
		qaFinishDoing(p, i)
		p.Todos[i].State, p.Todos[i].Result = "doing", ""
	case "qa-done":
		f := strings.Fields(text)
		if len(f) == 0 {
			return
		}
		i := qaTodoIndex(p, f[0])
		if i < 0 {
			return
		}
		res := "ok"
		if len(f) > 1 {
			switch r := strings.ToLower(f[1]); r {
			case "ok", "warn", "fail", "skip":
				res = r
			}
		}
		p.Todos[i].State, p.Todos[i].Result = "done", res
	case "qa-step":
		title := truncateTestRunText(text, qaMaxTodoTitle)
		if title == "" {
			return
		}
		if len(p.Steps) < 100 {
			p.Steps = append(p.Steps, title)
		}
		if len(p.Todos) >= qaMaxTodos {
			return
		}
		qaFinishDoing(p, -1)
		p.Todos = append(p.Todos, qaTodo{ID: "step-" + strconv.Itoa(len(p.Todos)+1), Title: title, State: "doing", Added: qaWorkStarted(p)})
	}
}

func qaTodoIndex(p *qaRunProgress, id string) int {
	if !qaTodoIDRe.MatchString(id) {
		return -1
	}
	for i, t := range p.Todos {
		if t.ID == id {
			return i
		}
	}
	return -1
}

// qaWorkStarted: has any step been started or finished yet?
func qaWorkStarted(p *qaRunProgress) bool {
	for _, t := range p.Todos {
		if t.State != "todo" {
			return true
		}
	}
	return false
}

// qaFinishDoing ticks off every step still marked doing (except keep), so a
// forgotten [slash:qa-done] does not leave two steps "bezig".
func qaFinishDoing(p *qaRunProgress, keep int) {
	for i := range p.Todos {
		if i != keep && p.Todos[i].State == "doing" {
			p.Todos[i].State, p.Todos[i].Result = "done", "ok"
		}
	}
}
