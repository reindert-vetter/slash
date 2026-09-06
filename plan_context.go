// plan_context.go — the context the `plan` tracker plans WITH: the Jira
// comments around a ticket and the pull requests that already merged for it.
//
// Two reviewer requests, verbatim: *"hier moeten we kijke naar de hoofdtaak en
// andere subtaken en wat er er allemaal gemerged is wat ermee te maken heeft.
// als dat meer dan 3 prs zijn, moet je de 3 meest relevante prs vinden"* and
// *"met het inplannen moet je ook kijken naar de comments die zijn gegeven in
// de jira tickets, hoofd en sub"*.
//
// It runs as ONE Activity (planLoadContext) between the gates and the
// generation — external reads only, no state of its own, so it needs nothing
// from the write boundary beyond being an Activity
// (.claude/rules/workflows-write-boundary.md). Everything it does is
// best-effort: no gh, no network, a ticket nobody ever opened a PR for — all of
// those yield less context, never a failed tracker.
//
// The RANKING is deliberately a pure Go function rather than a second Claude
// call: "de 3 meest relevante" is a question about which ticket a PR belongs
// to and how recent it is, both of which we know exactly. See
// rankPlanRelatedPRs.
//
// See .claude/docs/plan-page.md.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

// planContextTimeout bounds one gh/acli read, so a hung CLI costs this Activity
// its context instead of the whole tracker (the same "bound every subprocess
// yourself" rule modules/jira states in full).
const planContextTimeout = 30 * time.Second

// maxPlanPRFiles caps the changed-file list one related PR contributes to the
// prompt: enough to see WHERE it landed, not a full diff.
const maxPlanPRFiles = 25

// planRelatedKeys is the ticket family a plan looks at: this ticket first, then
// its main task, then the subtasks around it (its own children, and — for a
// subtask — its siblings). Pure and order-stable, because the order IS the
// relevance tier used by rankPlanRelatedPRs. Deduplicated and bounded.
func planRelatedKeys(doc planDoc) []string {
	out := make([]string, 0, maxPlanSearchKeys)
	seen := map[string]bool{}
	add := func(k string) {
		k = strings.ToUpper(strings.TrimSpace(k))
		if k == "" || seen[k] || !planKeyPattern.MatchString(k) || len(out) >= maxPlanSearchKeys {
			return
		}
		seen[k] = true
		out = append(out, k)
	}
	add(doc.Key)
	add(doc.ParentKey)
	for _, st := range doc.Subtasks {
		add(st.Key)
	}
	for _, sb := range doc.Siblings {
		add(sb.Key)
	}
	return out
}

// rankPlanRelatedPRs answers "welke 3 zijn het meest relevant": a PR found via
// THIS ticket's key beats one found via the main task, which beats one found
// via a subtask (keys is the tier order planRelatedKeys produced), and within
// one tier the most recently merged wins. Pure, so the choice is testable and
// replay-stable.
func rankPlanRelatedPRs(list []planRelatedPR, keys []string) []planRelatedPR {
	tier := map[string]int{}
	for i, k := range keys {
		tier[strings.ToUpper(k)] = i
	}
	rank := func(p planRelatedPR) int {
		if t, ok := tier[strings.ToUpper(p.Key)]; ok {
			return t
		}
		return len(keys) + 1
	}
	// Deduplicate on the PR number, keeping the best-ranked origin key.
	byNumber := map[int]planRelatedPR{}
	order := make([]int, 0, len(list))
	for _, p := range list {
		if prev, ok := byNumber[p.Number]; ok {
			if rank(p) < rank(prev) {
				byNumber[p.Number] = p
			}
			continue
		}
		byNumber[p.Number] = p
		order = append(order, p.Number)
	}
	out := make([]planRelatedPR, 0, len(order))
	for _, n := range order {
		out = append(out, byNumber[n])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if ri, rj := rank(out[i]), rank(out[j]); ri != rj {
			return ri < rj
		}
		return out[i].MergedAt > out[j].MergedAt // RFC3339 sorts lexically
	})
	if len(out) > maxPlanRelatedPRs {
		out = out[:maxPlanRelatedPRs]
	}
	return out
}

// searchMergedPRs asks gh for the merged PRs of ONE issue key. The key is
// matched on title/body (`in:title,body`) rather than as free text: a bare
// search term matches fuzzily and drags in unrelated PRs. A gh that cannot
// answer yields nothing, never an error.
func searchMergedPRs(ctx context.Context, key string) []planRelatedPR {
	if !planKeyPattern.MatchString(key) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, planContextTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "pr", "list",
		"--repo", repoSlugFor(""),
		"--state", "merged",
		"--search", key+" in:title,body",
		"--limit", "5",
		"--json", "number,title,url,mergedAt")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var raw []struct {
		Number   int    `json:"number"`
		Title    string `json:"title"`
		URL      string `json:"url"`
		MergedAt string `json:"mergedAt"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return nil
	}
	list := make([]planRelatedPR, 0, len(raw))
	for _, r := range raw {
		if r.Number <= 0 {
			continue
		}
		list = append(list, planRelatedPR{
			Number: r.Number, Title: strings.TrimSpace(r.Title),
			URL: r.URL, MergedAt: r.MergedAt, Key: key,
		})
	}
	return list
}

// prChangedFiles reads the paths one merged PR touched — the concrete half of
// "wat is er al gemerged": which files and modules the work landed in. Only
// asked for the three PRs that survived the ranking.
func prChangedFiles(ctx context.Context, number int) []string {
	ctx, cancel := context.WithTimeout(ctx, planContextTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "pr", "view", strconv.Itoa(number),
		"--repo", repoSlugFor(""), "--json", "files")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var meta struct {
		Files []struct {
			Path string `json:"path"`
		} `json:"files"`
	}
	if json.Unmarshal(out, &meta) != nil {
		return nil
	}
	files := make([]string, 0, len(meta.Files))
	for _, f := range meta.Files {
		if f.Path == "" {
			continue
		}
		if len(files) >= maxPlanPRFiles {
			files = append(files, fmt.Sprintf("…(%d meer)", len(meta.Files)-len(files)))
			break
		}
		files = append(files, f.Path)
	}
	return files
}
