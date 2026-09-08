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
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"slash/modules/jira"
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

// ---------------------------------------------------------------------------
// Referenced tickets OUTSIDE this one's own family — a Jira link or a bare
// key mention, plus (best-effort) the branch that ticket already has work on.
//
// Reviewer request, verbatim: *"als het goed is moet PROD-254 dan rekening
// houden met PROD-216. kan je ervoor zorgen dat je achterhaalt wat de branch
// is waar PROD-216 al iets in heeft gedaan? waarschijnlijk zit dat in een
// subtaak, soms ook in een description."* — every Jira link AND every bare
// key-shaped mention (description/subtask/comment) is followed, and the
// branch is looked for in BOTH the PR/branch text on GitHub and the Jira
// text itself. See .claude/docs/plan-page.md.
// ---------------------------------------------------------------------------

// maxPlanReferencedIssues bounds how many OTHER tickets (outside this
// ticket's own family, see planRelatedKeys) get their own context pulled in —
// each one costs its own acli (+ a few more, see
// maxPlanReferencedSubtaskTextReads) and gh read.
const maxPlanReferencedIssues = 3

// maxPlanReferencedSubtaskTextReads bounds how many of a referenced ticket's
// OWN subtasks get read while looking for a branch mention in their text —
// the reviewer's own hint that the actual work often sits one level down
// ("waarschijnlijk zit dat in een subtaak").
const maxPlanReferencedSubtaskTextReads = 2

// planKeyMentionPattern matches a Jira-key-shaped token in free text
// (description, comment) — the same shape planKeyPattern validates, minus the
// bare-numeric form (a free-text "42" is never a ticket reference).
var planKeyMentionPattern = regexp.MustCompile(`\b[A-Z][A-Z0-9]+-\d+\b`)

// planReferencedIssue is one ticket referenced by this one's family but
// OUTSIDE it — via an official Jira link, or a bare mention in free text.
type planReferencedIssue struct {
	Key    string `json:"key"`
	Title  string `json:"title,omitempty"`
	Status string `json:"status,omitempty"`
	URL    string `json:"url,omitempty"`
	// Reason is in WORDS, never a colour/icon alone (the colourblind rule):
	// the Jira link's own relation phrase ("relates to", "is blocked by", …)
	// or "vermeld in tekst" for a bare mention with no official link.
	Reason string `json:"reason"`
	// Branch/BranchSource are best-effort — Jira has no fixed convention for
	// stating a branch name, so a Jira-text match is a HEURISTIC and always
	// labelled as such (BranchSource starting with "jira-tekst"), never shown
	// as fact. A GitHub PR's own headRefName is authoritative and preferred.
	Branch       string `json:"branch,omitempty"`
	BranchSource string `json:"branchSource,omitempty"`
}

// collectPlanReferencedKeys gathers every OTHER ticket key this ticket's
// family (doc + parent + subtasks + siblings) points at, deduplicated,
// excluding the family's own keys, bounded by maxPlanReferencedIssues.
// linksByKey carries the official Links already read for each family member
// (planLoadContext already fetches every member's own Issue() for its
// comments, so this reuses that read rather than paying for a second one).
// An official link is collected before a bare mention, so when both name the
// same ticket the real relation phrase wins as the recorded Reason (seen[]
// keeps only the first).
func collectPlanReferencedKeys(doc planDoc, linksByKey map[string][]jira.IssueLink) []planReferencedIssue {
	family := map[string]bool{}
	for _, k := range planRelatedKeys(doc) {
		family[strings.ToUpper(k)] = true
	}
	out := make([]planReferencedIssue, 0, maxPlanReferencedIssues)
	seen := map[string]bool{}
	add := func(key, reason string) {
		key = strings.ToUpper(strings.TrimSpace(key))
		if key == "" || family[key] || seen[key] || !planKeyPattern.MatchString(key) || len(out) >= maxPlanReferencedIssues {
			return
		}
		seen[key] = true
		out = append(out, planReferencedIssue{Key: key, Reason: orDash(reason)})
	}
	for _, links := range linksByKey {
		for _, l := range links {
			add(l.Key, l.Relation)
		}
	}
	var text strings.Builder
	text.WriteString(doc.Description)
	text.WriteString(" ")
	text.WriteString(doc.ParentDescription)
	for _, c := range doc.Comments {
		text.WriteString(" " + c.Body)
	}
	for _, c := range doc.RelatedComments {
		text.WriteString(" " + c.Body)
	}
	for _, k := range planKeyMentionPattern.FindAllString(text.String(), -1) {
		add(k, "vermeld in tekst")
	}
	return out
}

// branchMentionPattern finds a plausible branch NAME containing key in free
// Jira text — best-effort only (Jira has no fixed convention for stating a
// branch name): a slash/dash/dot-delimited token with no whitespace that
// contains the key, case-insensitively (a branch name is often lowercased
// even though the Jira key itself is upper).
func branchMentionPattern(key string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)[\w./-]*` + regexp.QuoteMeta(strings.ToUpper(key)) + `[\w./-]*`)
}

// findBranchInText returns the first plausible branch-shaped match, trimmed
// of surrounding punctuation a reviewer might have typed around it
// ("branch: `foo`." → "foo").
func findBranchInText(key, text string) string {
	m := branchMentionPattern(key).FindString(text)
	return strings.Trim(m, "`'\".,;: ")
}

// findBranchViaGH is searchMergedPRs's sibling: ANY PR state (open, draft,
// closed, merged) mentioning key, plus its own branch name — "al iets gedaan"
// does not require having merged yet. An OPEN PR (work genuinely in
// progress) is preferred over a merged/closed one; within a tier, the most
// recently updated wins. A gh that cannot answer yields "", never an error.
func findBranchViaGH(ctx context.Context, key string) (branch, source string) {
	if !planKeyPattern.MatchString(key) {
		return "", ""
	}
	ctx, cancel := context.WithTimeout(ctx, planContextTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "pr", "list",
		"--repo", repoSlugFor(""),
		"--state", "all",
		"--search", key+" in:title,body",
		"--limit", "10",
		"--json", "number,state,headRefName,updatedAt")
	out, err := cmd.Output()
	if err != nil {
		return "", ""
	}
	var raw []struct {
		Number      int    `json:"number"`
		State       string `json:"state"`
		HeadRefName string `json:"headRefName"`
		UpdatedAt   string `json:"updatedAt"`
	}
	if json.Unmarshal(out, &raw) != nil || len(raw) == 0 {
		return "", ""
	}
	sort.SliceStable(raw, func(i, j int) bool {
		oi, oj := raw[i].State == "OPEN", raw[j].State == "OPEN"
		if oi != oj {
			return oi
		}
		return raw[i].UpdatedAt > raw[j].UpdatedAt // RFC3339 sorts lexically
	})
	best := raw[0]
	if best.HeadRefName == "" {
		return "", ""
	}
	return best.HeadRefName, fmt.Sprintf("pr:#%d", best.Number)
}

// resolvePlanReferencedIssue enriches one referenced key (found via
// collectPlanReferencedKeys) with its own title/url and — best-effort — the
// branch it already has work on: a GitHub PR/branch mentioning the key wins
// (authoritative) over a Jira-text guess (a heuristic, always labelled as
// such); the Jira-text guess itself looks at the ticket's own
// description+comments, then — the reviewer's own hint that the work often
// sits one level down — up to maxPlanReferencedSubtaskTextReads of its own
// subtasks. Best-effort throughout: a missing gh/acli costs context, never
// fails the caller.
func resolvePlanReferencedIssue(ctx context.Context, jc jira.Client, ref planReferencedIssue) planReferencedIssue {
	out := ref
	var issue jira.Issue
	if jc != nil {
		if got, err := jc.Issue(ctx, ref.Key); err == nil {
			issue = got
			out.Title, out.URL = issue.Title, issue.URL
		}
	}
	if branch, source := findBranchViaGH(ctx, ref.Key); branch != "" {
		out.Branch, out.BranchSource = branch, source
		return out
	}
	ownText := issue.Description
	for _, c := range issue.Comments {
		ownText += " " + c.Body
	}
	if b := findBranchInText(ref.Key, ownText); b != "" {
		out.Branch, out.BranchSource = b, "jira-tekst"
		return out
	}
	if jc == nil {
		return out
	}
	reads := 0
	for _, st := range issue.Subtasks {
		if reads >= maxPlanReferencedSubtaskTextReads {
			break
		}
		reads++
		sub, err := jc.Issue(ctx, st.Key)
		if err != nil {
			continue
		}
		subText := sub.Description
		for _, c := range sub.Comments {
			subText += " " + c.Body
		}
		if b := findBranchInText(ref.Key, subText); b != "" {
			out.Branch, out.BranchSource = b, "jira-tekst ("+st.Key+")"
			return out
		}
	}
	return out
}
