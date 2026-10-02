// touch_ai.go — the touch_ai workflow: an AI read of a PR's migration/API
// changes for the /pr-overview "Migrations & API changes" rows, on top of the
// deterministic touchSummary (inbox_touch_summary.go). One context-only Haiku
// call returns three things at once:
//
//   - an impact label for the whole PR (additive / caution / breaking) plus a
//     short reason,
//   - one sentence explaining what changes functionally,
//   - a verdict (safe / caution / breaking) per summary chip — every column,
//     route, key or class the row shows as its own chip.
//
// Started automatically from the pr_inbox tracker's refreshInbox Activity
// (autoStartTouchAI), gated by the "Live AI assistent" toggle (autowarn) and,
// for now, by a hardcoded allowlist (touchAIAllowlist). One Execution per PR
// head commit, under a deterministic Run ID, so the per-minute inbox poll
// never repeats the LLM call; a push gives a new head SHA and thus a new run.
// The result lands in modules/touchai and is joined onto the status backfill
// at READ time (handleInboxStatus), matched on the row's touchSha.
//
// See .claude/docs/pr-overview.md ("AI read of the change") and
// .claude/docs/workflows-analysis.md ("touch_ai").
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/langpref"
)

// WorkflowTouchAI is the Workflow Type of the AI read of a PR's migration/API
// changes. Completes when done (no signals).
const WorkflowTouchAI = "touch_ai"

// touchAIAllowlist limits the automatic touch_ai run to these PRs (statusKey
// form) while the feature is being tried out — reviewer request: "doe ai
// dingen enzo nu alleen voor" AUTH-667 (plug-and-pay/plug-and-pay #13989), later also BUG-5203 (#14005).
// Remove the check in autoStartTouchAI to enable it for every row.
var touchAIAllowlist = map[string]bool{
	statusKey("", 13989): true,
	statusKey("", 14005): true,
}

// maxTouchAIPatch clips one file's patch in the prompt; a migration/API
// verdict needs the shape of the change, not every line of a huge file.
const maxTouchAIPatch = 6000

// TouchAIInput starts one touch_ai Execution: the PR, the head commit the
// verdict is for, and the migration/API paths to read (from the status
// backfill, so the Activity fetches nothing it does not need).
type TouchAIInput struct {
	Repo    string   `json:"repo,omitempty"`
	PR      int      `json:"pr"`
	HeadSHA string   `json:"headSha"`
	Files   []string `json:"files"`
}

// touchAI is the stored result (modules/touchai) and the `touchAi` field of a
// status entry. Status "failed" means the run finished without a usable
// answer (offline, Claude hiccup, unparsable output) — the frontend then
// shows nothing extra.
type touchAI struct {
	Status  string                 `json:"status"`
	Impact  string                 `json:"impact,omitempty"` // additive | caution | breaking
	Reason  string                 `json:"reason,omitempty"`
	Summary string                 `json:"summary,omitempty"`
	Chips   map[string]touchAIChip `json:"chips,omitempty"` // touchChip.Key → verdict
}

type touchAIChip struct {
	Verdict string `json:"verdict"` // safe | caution | breaking
	Note    string `json:"note,omitempty"`
}

// touchChip is one chip of a summary row. Key MUST match chipKey in
// src/overview.mjs: "<db|api>|<item name>|<sign><value>", or
// "<db|api>|<item name>|" for an item-level chip (an item with no
// add/del/chg list, e.g. "PolicyController aangepast").
type touchChip struct {
	Key   string
	Label string
}

// touchChips flattens a summary into its chips, in display order.
func touchChips(sum *touchSummary) []touchChip {
	if sum == nil {
		return nil
	}
	var out []touchChip
	add := func(group, label string, items []touchItem) {
		for _, it := range items {
			base := group + "|" + it.Name + "|"
			n := 0
			for _, l := range []struct {
				sign string
				vals []string
			}{{"+", it.Add}, {"−", it.Del}, {"~", it.Chg}} {
				for _, v := range l.vals {
					out = append(out, touchChip{Key: base + l.sign + v, Label: fmt.Sprintf("%s %s %s: %s%s", label, it.Kind, it.Name, l.sign, v)})
					n++
				}
			}
			if n == 0 {
				out = append(out, touchChip{Key: base, Label: fmt.Sprintf("%s %s %s (new=%v)", label, it.Kind, it.Name, it.New)})
			}
		}
	}
	add("db", "DB", sum.DB)
	add("api", "API", sum.API)
	return out
}

// touchAIRunID is the deterministic Run ID: one run per PR head commit.
func touchAIRunID(repo string, pr int, headSHA string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s#%d@%s", repo, pr, headSHA)))
	return "touchai-" + hex.EncodeToString(sum[:12])
}

// touchAIPrompt builds the call-specific part of the prompt: the numbered
// chips and the clipped patches. The task framing travels separately as
// claude.TouchAISystemPrompt.
func touchAIPrompt(files []touchedFile, chips []touchChip) string {
	var b strings.Builder
	b.WriteString("Onderdelen:\n")
	for i, c := range chips {
		fmt.Fprintf(&b, "%d. %s\n", i+1, c.Label)
	}
	b.WriteString("\nDiff:\n")
	for _, f := range files {
		fmt.Fprintf(&b, "\n--- %s (%s)\n%s\n", f.Path, f.Status, clipForPrompt(f.Patch, maxTouchAIPatch))
	}
	return b.String()
}

// parseTouchAI extracts the first {...} JSON object from the model output and
// normalizes it: an unknown impact or an empty answer yields "failed", an
// unknown verdict or an out-of-range chip number is dropped.
func parseTouchAI(raw string, chips []touchChip) touchAI {
	failed := touchAI{Status: "failed"}
	start := strings.IndexByte(raw, '{')
	end := strings.LastIndexByte(raw, '}')
	if start < 0 || end <= start {
		return failed
	}
	var out struct {
		Impact  string `json:"impact"`
		Reason  string `json:"reason"`
		Summary string `json:"summary"`
		Chips   []struct {
			N       int    `json:"n"`
			Verdict string `json:"verdict"`
			Note    string `json:"note"`
		} `json:"chips"`
	}
	if err := json.Unmarshal([]byte(raw[start:end+1]), &out); err != nil {
		return failed
	}
	impact := strings.ToLower(strings.TrimSpace(out.Impact))
	switch impact {
	case "additive", "caution", "breaking":
	default:
		return failed
	}
	res := touchAI{
		Status:  "done",
		Impact:  impact,
		Reason:  strings.TrimSpace(out.Reason),
		Summary: strings.TrimSpace(out.Summary),
	}
	for _, c := range out.Chips {
		v := strings.ToLower(strings.TrimSpace(c.Verdict))
		if c.N < 1 || c.N > len(chips) || (v != "safe" && v != "caution" && v != "breaking") {
			continue
		}
		if res.Chips == nil {
			res.Chips = map[string]touchAIChip{}
		}
		res.Chips[chips[c.N-1].Key] = touchAIChip{Verdict: v, Note: strings.TrimSpace(c.Note)}
	}
	return res
}

// fetchTouchedFilesFn is fetchTouchedFiles, swappable in tests (no real gh).
var fetchTouchedFilesFn = fetchTouchedFiles

// touchAIWorkflow: generate (fetch patches + one Haiku call, one Activity),
// then save. Fixed Activity order/count, no map iteration — deterministic.
func touchAIWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in TouchAIInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	var res touchAI
	if err := w.ExecuteActivity("generateTouchAI", in, &res); err != nil {
		return nil, fmt.Errorf("generate: %w", err)
	}
	if err := w.ExecuteActivity("saveTouchAI", map[string]any{"in": in, "result": res}, nil); err != nil {
		return nil, fmt.Errorf("save: %w", err)
	}
	return json.Marshal(map[string]string{"status": res.Status})
}

// registerTouchAI registers the touch_ai workflow and its two Activities.
func (m *TaskManager) registerTouchAI(engine *tembed.Engine) {
	engine.RegisterWorkflow(WorkflowTouchAI, touchAIWorkflow)

	// Activity: fetch the migration/API patches (gh) and ask Haiku for the
	// verdict. Best-effort: any failure records "failed" rather than sinking
	// the run — the inbox row then just keeps its deterministic summary.
	engine.RegisterActivity("generateTouchAI", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg TouchAIInput
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		failed, _ := json.Marshal(touchAI{Status: "failed"})
		if m.claude == nil || len(arg.Files) == 0 {
			return failed, nil
		}
		wanted := map[string]bool{}
		for _, f := range arg.Files {
			wanted[f] = true
		}
		files, err := fetchTouchedFilesFn(ctx, arg.Repo, arg.PR, wanted)
		if err != nil || len(files) == 0 {
			m.logf("touch_ai: pr=%d fetch patches skipped: %v", arg.PR, err)
			return failed, nil
		}
		chips := touchChips(summarizeTouched(files))
		raw, err := m.claude.Run(ctx, claude.RunRequest{
			Prompt:       touchAIPrompt(files, chips),
			Model:        claude.ModelHaiku,
			SystemPrompt: claude.TouchAISystemPrompt + explainLangTail(m.LangFor(ctx, langpref.KindExplain)),
		})
		if err != nil {
			m.logf("touch_ai: pr=%d generate skipped: %v", arg.PR, err)
			return failed, nil
		}
		return json.Marshal(parseTouchAI(raw, chips))
	})

	// Activity: persist the result for this PR head (write, workflow-driven).
	engine.RegisterActivity("saveTouchAI", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg struct {
			In     TouchAIInput `json:"in"`
			Result touchAI      `json:"result"`
		}
		if err := json.Unmarshal(in, &arg); err != nil {
			return nil, err
		}
		if m.touchai == nil {
			return nil, nil
		}
		res, _ := json.Marshal(arg.Result)
		return nil, m.touchai.Save(ctx, arg.In.Repo, arg.In.PR, arg.In.HeadSHA, string(res), time.Now().UTC().Format(time.RFC3339))
	})
}

// touchAIStarts lists the touch_ai runs refreshInbox should start for this
// snapshot: allowlisted "Migrations & API changes" rows with a known head SHA
// and at least one migration/API file. Pure, so it is unit-testable.
func touchAIStarts(sections []inboxSection, statuses map[string]prStatus) []TouchAIInput {
	var out []TouchAIInput
	for _, s := range sections {
		if s.Title != touchedSectionTitle {
			continue
		}
		for _, r := range s.PRs {
			key := rowKey(r)
			st, ok := statuses[key]
			if !ok || !touchAIAllowlist[key] || st.TouchSHA == "" {
				continue
			}
			files := append(append([]string{}, st.MigrationFiles...), st.APIFiles...)
			if len(files) == 0 {
				continue
			}
			out = append(out, TouchAIInput{Repo: r.Repo, PR: r.Number, HeadSHA: st.TouchSHA, Files: files})
		}
	}
	return out
}

// autoStartTouchAI fires the touch_ai runs for this snapshot, fire-and-forget
// (StartWorkflowID drives the whole run inline, and refreshInbox must stay
// fast). Gated like every other automatic Claude call: runtime only, never
// offline (the Activity needs gh), and off when "Live AI assistent" is off.
// StartWorkflowID dedups per Run ID; touchAITried also skips the store lookup
// for a run this process already started.
func (m *TaskManager) autoStartTouchAI(ctx context.Context, sections []inboxSection, statuses map[string]prStatus) {
	if !m.runtimeReady || ghDisabled() {
		return
	}
	starts := touchAIStarts(sections, statuses)
	if len(starts) == 0 {
		return
	}
	if enabled, err := m.AutoWarnEnabled(ctx); err != nil || !enabled {
		return
	}
	for _, in := range starts {
		id := touchAIRunID(in.Repo, in.PR, in.HeadSHA)
		m.mu.Lock()
		if m.touchAITried[id] {
			m.mu.Unlock()
			continue
		}
		if m.touchAITried == nil {
			m.touchAITried = map[string]bool{}
		}
		m.touchAITried[id] = true
		m.mu.Unlock()
		go func(in TouchAIInput, id string) {
			if _, err := m.engine.StartWorkflowID(id, WorkflowTouchAI, in); err != nil {
				m.logf("touch_ai: auto-start pr=%d: %v", in.PR, err)
			}
		}(in, id)
	}
}

// withTouchAI joins the stored AI result onto a status entry, matched on the
// row's current head SHA (read-only; used by handleInboxStatus).
func (m *TaskManager) withTouchAI(ctx context.Context, repo string, pr int, st prStatus) prStatus {
	if m == nil || m.touchai == nil || st.TouchSHA == "" {
		return st
	}
	raw, ok, err := m.touchai.Get(ctx, repo, pr, st.TouchSHA)
	if err != nil || !ok {
		return st
	}
	var res touchAI
	if json.Unmarshal([]byte(raw), &res) == nil && res.Status == "done" {
		st.TouchAI = &res
	}
	return st
}
