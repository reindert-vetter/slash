package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"slash/modules/comments"
	"slash/modules/jira"
	"slash/modules/prmeta"
	"slash/modules/taskinbox"
)

// taskinbox_analysis.go builds the task-inbox aggregation: three independent
// task sources (open PRs where you're a reviewer, unread comments on your own
// PRs, Jira tickets assigned to you) turned into one flat, scored list. It is
// the Activity-body service the task_inbox workflow drives (refreshTasks in
// workflows.go) — a task is derived, not primarily stored anywhere, so this
// file re-fetches everything on every refresh and the workflow Activity
// full-swaps the result into the taskinbox read-model.
//
// Fetching (GitHub/Jira/comments reads) is kept separate from the pure
// scoring (computeTaskPoints, pointRules below) so the scoring table is
// independently unit-testable without touching any of the three sources.

// Task kinds (taskinbox.Task.Kind).
const (
	kindPRReview      = "pr_review"
	kindCommentUnread = "comment_unread"
	kindJira          = "jira"
)

// baseScore is each kind's starting score, before any PointRule adds to it.
var baseScore = map[string]int{
	kindPRReview:      20,
	kindCommentUnread: 20,
	kindJira:          10,
}

// taskSignals carries the raw, kind-specific facts a PointRule evaluates —
// deliberately a flat struct (only the fields relevant to *some* rule are
// set for any given candidate) so computeTaskPoints/pointRules stay a pure,
// table-driven function of already-fetched data, independently testable.
type taskSignals struct {
	Kind string

	// pr_review
	ChecksFailing bool // latest CI rollup is FAILURE/ERROR
	AgeDays       int  // days since the PR was opened (0 = unknown/just opened)

	// comment_unread
	ChangesRequested bool // the thread's PR currently has reviewDecision CHANGES_REQUESTED
	UnansweredDays   int  // days since the thread's last message (0 = today)

	// jira
	JiraActive bool // ticket status is not Backlog/To Do
}

// PointNote is one line of a task's score breakdown ("basis", "CI faalt",
// …) — kept alongside the total so the score stays transparent instead of a
// single opaque number.
type PointNote struct {
	Label  string `json:"label"`
	Points int    `json:"points"`
}

// PointRule is one declarative, optional +points rule stacked on top of a
// kind's base score. Eval returns the extra points to add plus a label
// describing why; points == 0 means the rule does not apply to this
// candidate (and is left out of the notes entirely). Adding a new rule is a
// single new table entry — no change to computeTaskPoints itself.
type PointRule struct {
	ID   string
	Kind string
	Eval func(taskSignals) (points int, label string)
}

// pointRules is the full, ordered set of bonus rules. Order determines the
// order of PointNotes in the breakdown (cosmetic only — points are summed
// regardless of order).
var pointRules = []PointRule{
	{
		ID: "ci_failing", Kind: kindPRReview,
		Eval: func(s taskSignals) (int, string) {
			if !s.ChecksFailing {
				return 0, ""
			}
			return 10, "CI faalt"
		},
	},
	{
		ID: "pr_aging", Kind: kindPRReview,
		Eval: func(s taskSignals) (int, string) {
			if s.AgeDays <= 3 {
				return 0, ""
			}
			return 10, fmt.Sprintf("wacht al %d dagen", s.AgeDays)
		},
	},
	{
		ID: "changes_requested", Kind: kindCommentUnread,
		Eval: func(s taskSignals) (int, string) {
			if !s.ChangesRequested {
				return 0, ""
			}
			return 10, "hoort bij een changes-requested review"
		},
	},
	{
		// +10 per extra dag onbeantwoord, gecapt op +30 (dag 1 = 10, dag 2 =
		// 20, dag 3+ = 30). A same-day (0 days) reaction doesn't yet count as
		// "aging" — it only just became unread.
		ID: "comment_aging", Kind: kindCommentUnread,
		Eval: func(s taskSignals) (int, string) {
			if s.UnansweredDays <= 0 {
				return 0, ""
			}
			pts := s.UnansweredDays * 10
			if pts > 30 {
				pts = 30
			}
			return pts, fmt.Sprintf("onbeantwoord sinds %d dagen", s.UnansweredDays)
		},
	},
	{
		ID: "jira_active", Kind: kindJira,
		Eval: func(s taskSignals) (int, string) {
			if !s.JiraActive {
				return 0, ""
			}
			return 10, "actief in werk"
		},
	},
}

// computeTaskPoints is the pure scoring function: base score for the kind,
// plus every matching PointRule that applies. Always returns at least the
// "basis" note, so the breakdown never silently drops the base score.
func computeTaskPoints(sig taskSignals) (int, []PointNote) {
	points := baseScore[sig.Kind]
	notes := []PointNote{{Label: "basis", Points: points}}
	for _, r := range pointRules {
		if r.Kind != sig.Kind {
			continue
		}
		p, label := r.Eval(sig)
		if p == 0 {
			continue
		}
		points += p
		notes = append(notes, PointNote{Label: label, Points: p})
	}
	return points, notes
}

// --- candidate assembly -----------------------------------------------------

// taskCandidate is one not-yet-scored task, gathered from one of the three
// sources below. detail is marshalled as-is into taskinbox.Task.Detail.
type taskCandidate struct {
	id        string
	kind      string
	title     string
	subtitle  string
	pr        int
	url       string
	updatedAt time.Time
	detail    any
	signals   taskSignals
}

// prReviewDetail is the kind-specific Detail payload for a "pr_review" task.
type prReviewDetail struct {
	Title          string `json:"title"`
	Author         string `json:"author"`
	Additions      int    `json:"additions"`
	Deletions      int    `json:"deletions"`
	ReviewDecision string `json:"reviewDecision"`
	ChecksState    string `json:"checksState"`
	ChecksTotal    int    `json:"checksTotal"`
	HasGraph       bool   `json:"hasGraph"`
}

// commentUnreadMessage is one message in a comment_unread task's thread.
type commentUnreadMessage struct {
	Author    string `json:"author"`
	CreatedAt string `json:"createdAt"`
	Body      string `json:"body"`
}

// commentUnreadDetail is the kind-specific Detail payload for a
// "comment_unread" task: the thread itself, plus (if the comment carries
// one) the relative code fragment it hangs on.
type commentUnreadDetail struct {
	File     string                 `json:"file"`
	Label    string                 `json:"label"`
	Gran     string                 `json:"gran,omitempty"`
	Code     string                 `json:"code,omitempty"`
	RowStart int                    `json:"rowStart"`
	RowEnd   int                    `json:"rowEnd"`
	Seg      string                 `json:"seg,omitempty"`
	Messages []commentUnreadMessage `json:"messages"`
}

// jiraDetail is the kind-specific Detail payload for a "jira" task.
type jiraDetail struct {
	Key         string `json:"key"`
	Status      string `json:"status"`
	Description string `json:"description"`
	URL         string `json:"url"`
}

// needsYourReviewTitle/myOpenPRSectionTitles name the existing inboxSections
// entries (inbox.go) this file reuses instead of duplicating GitHub search
// expressions: "Needs your review" is exactly source A (open PRs where you
// are a reviewer); the remaining four sections are exactly every OTHER open
// PR you authored (source B's PR scope) — together they exhaust
// "author:@me state:open", since buildInbox's own cross-section de-dupe
// guarantees a PR only ever lands in the first section it matches.
const needsYourReviewTitle = "Needs your review"

var myOpenPRSectionTitles = map[string]bool{
	"Ready to merge":               true,
	"Needs action":                 true,
	"Waiting for review or checks": true,
	"Your drafts":                  true,
}

// taskInboxDeps bundles the read-only dependencies buildTaskInbox needs, so
// the aggregation stays a plain function instead of a method on TaskManager
// (no engine/workflow concerns here — this file is pure Activity-body logic,
// like relations.go/callresolve_analysis.go).
type taskInboxDeps struct {
	db       *sql.DB
	comments *comments.Module
	jira     jira.Client
	// prmeta is passed through to buildInboxSnapshot for the "fully approved
	// since" fold (see combineSinceMoment, inbox.go) — nil is fine.
	prmeta *prmeta.Module
}

// buildTaskInbox fetches all three task sources and turns them into scored
// taskinbox.Task rows, ready for the refreshTasks Activity to full-swap into
// the read-model. Each source is best-effort/independent: a failure in one
// (e.g. GitHub unreachable) does not prevent the others from still
// contributing — mirrors buildInboxSnapshot's "keep the last good snapshot
// on a hiccup" philosophy, just narrowed to "skip only the failing source".
func buildTaskInbox(ctx context.Context, deps taskInboxDeps) ([]taskinbox.Task, error) {
	var candidates []taskCandidate

	// Sources A + B share one inbox fetch (buildInboxSnapshot already knows
	// how to go offline via SLASH_INBOX, see inbox.go) — no separate GitHub
	// query is needed for "my own open PRs" beyond what the inbox already
	// computes for its own sections.
	snap, err := buildInboxSnapshot(ctx, deps.db, deps.prmeta)
	if err != nil {
		snap = nil // best-effort: PR-derived sources simply contribute nothing this round
	}
	if snap != nil {
		// snap.GeneratedFor is already the resolved login (ghLogin(ctx) online,
		// the fixture's own field offline — see buildInboxSnapshot) — reused
		// here instead of calling ghLogin(ctx) again, which would shell out to
		// the real `gh` even under SLASH_GITHUB=off (ghLogin itself has no
		// offline branch; every existing caller only reaches it from the
		// non-offline path of buildInboxSnapshot/buildInbox).
		login := snap.GeneratedFor
		if login == "" && !ghDisabled() {
			login = ghLogin(ctx)
		}
		candidates = append(candidates, prReviewCandidates(snap)...)
		if deps.comments != nil {
			cc, err := unreadCommentCandidates(ctx, deps.comments, snap, login)
			if err == nil {
				candidates = append(candidates, cc...)
			}
		}
	}

	if deps.jira != nil {
		jc, err := jiraCandidates(ctx, deps.jira)
		if err == nil {
			candidates = append(candidates, jc...)
		}
	}

	tasks := make([]taskinbox.Task, 0, len(candidates))
	for _, c := range candidates {
		points, notes := computeTaskPoints(c.signals)
		notesJSON, _ := json.Marshal(notes)
		detailJSON, _ := json.Marshal(c.detail)
		tasks = append(tasks, taskinbox.Task{
			ID: c.id, Kind: c.kind, Title: c.title, Subtitle: c.subtitle,
			Points: points, PointNotes: string(notesJSON),
			PR: c.pr, URL: c.url, Detail: string(detailJSON),
			UpdatedAt: c.updatedAt.UnixMilli(),
		})
	}
	return tasks, nil
}

// prReviewCandidates is task source A: open PRs where the user is a
// reviewer, taken straight from the already-fetched "Needs your review"
// inbox section (see needsYourReviewTitle above) — no separate GitHub call.
func prReviewCandidates(snap *snapshotResult) []taskCandidate {
	var out []taskCandidate
	for _, sec := range snap.Sections {
		if sec.Title != needsYourReviewTitle {
			continue
		}
		for _, row := range sec.PRs {
			// The personal task inbox is deliberately still primary-repo only:
			// a task id is "pr:<n>" and its link is /pr/<n>, neither of which
			// carries a repo. A PR from another repo is listed in the overview
			// (which does know about repos) but does not become a scored task.
			if canonRepo(row.Repo) != "" {
				continue
			}
			st := snap.Statuses[statusKey("", row.Number)]
			sig := taskSignals{
				Kind:          kindPRReview,
				ChecksFailing: st.ChecksState == "FAILURE" || st.ChecksState == "ERROR",
				AgeDays:       prAgeDays(row.CreatedAt),
			}
			updated, _ := time.Parse(time.RFC3339, row.UpdatedAt)
			out = append(out, taskCandidate{
				id:        fmt.Sprintf("pr:%d", row.Number),
				kind:      kindPRReview,
				title:     row.Title,
				subtitle:  fmt.Sprintf("PR #%d · %s", row.Number, row.Author),
				pr:        row.Number,
				url:       row.URL,
				updatedAt: updated,
				detail: prReviewDetail{
					Title: row.Title, Author: row.Author,
					Additions: row.Additions, Deletions: row.Deletions,
					ReviewDecision: st.ReviewDecision,
					ChecksState:    st.ChecksState, ChecksTotal: st.ChecksTotal,
					HasGraph: row.HasGraph,
				},
				signals: sig,
			})
		}
	}
	return out
}

// prAgeDays returns the number of whole days since createdAt (RFC3339), or 0
// if createdAt is empty/unparsable (an older fixture, or a transient GitHub
// gap) — 0 never triggers the "pr_aging" rule, which is the safe default.
func prAgeDays(createdAt string) int {
	if createdAt == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		return 0
	}
	days := int(time.Since(t).Hours() / 24)
	if days < 0 {
		return 0
	}
	return days
}

// unreadCommentCandidates is task source B: for every open PR the user
// authored (myOpenPRSectionTitles' rows within the already-fetched
// snapshot), every comment thread whose last message wasn't written by the
// user and isn't resolved yet. A "thread" here is one comments.Comment plus
// its Reactions (the module's own shape — a comment IS the thread root, its
// reactions are the replies, see modules/comments' doc comment).
func unreadCommentCandidates(ctx context.Context, cs *comments.Module, snap *snapshotResult, login string) ([]taskCandidate, error) {
	var out []taskCandidate
	for _, sec := range snap.Sections {
		if !myOpenPRSectionTitles[sec.Title] {
			continue
		}
		for _, row := range sec.PRs {
			// Primary repo only, for the same reason as prReviewCandidates
			// above (and so a foreign PR 12 can never be handed the primary
			// repo's PR 12 comment threads).
			if canonRepo(row.Repo) != "" {
				continue
			}
			list, err := cs.List(ctx, "", row.Number)
			if err != nil {
				continue // best-effort per PR, mirrors the rest of this file
			}
			reviewDecision := snap.Statuses[statusKey("", row.Number)].ReviewDecision
			for _, c := range list {
				lastAuthor, lastCreatedAt, lastBody := c.Author, c.CreatedAt, c.Body
				if len(c.Reactions) > 0 {
					last := c.Reactions[len(c.Reactions)-1]
					lastAuthor, lastCreatedAt, lastBody = last.Author, last.CreatedAt, last.Body
				}
				if c.Status == "resolved" || lastAuthor == "" || lastAuthor == login {
					continue // read, or nothing to read yet
				}
				unansweredDays := 0
				if t, err := time.Parse(time.RFC3339Nano, lastCreatedAt); err == nil {
					unansweredDays = int(time.Since(t).Hours() / 24)
					if unansweredDays < 0 {
						unansweredDays = 0
					}
				}
				sig := taskSignals{
					Kind:             kindCommentUnread,
					ChangesRequested: reviewDecision == "CHANGES_REQUESTED",
					UnansweredDays:   unansweredDays,
				}
				messages := make([]commentUnreadMessage, 0, len(c.Reactions)+1)
				messages = append(messages, commentUnreadMessage{Author: c.Author, CreatedAt: c.CreatedAt, Body: c.Body})
				for _, r := range c.Reactions {
					messages = append(messages, commentUnreadMessage{Author: r.Author, CreatedAt: r.CreatedAt, Body: r.Body})
				}
				updated, _ := time.Parse(time.RFC3339Nano, lastCreatedAt)
				out = append(out, taskCandidate{
					id:        "comment:" + c.ID,
					kind:      kindCommentUnread,
					title:     fmt.Sprintf("Onbeantwoorde reactie · PR #%d", row.Number),
					subtitle:  commentSnippet(lastBody, 80),
					pr:        row.Number,
					url:       row.URL,
					updatedAt: updated,
					detail: commentUnreadDetail{
						File: c.File, Label: c.Label, Gran: c.Gran, Code: c.Code,
						RowStart: c.RowStart, RowEnd: c.RowEnd, Seg: c.Seg,
						Messages: messages,
					},
					signals: sig,
				})
			}
		}
	}
	return out, nil
}

// jiraCandidates is task source C: every Jira issue assigned to the user,
// regardless of status.
func jiraCandidates(ctx context.Context, jr jira.Client) ([]taskCandidate, error) {
	issues, err := jr.AssignedToMe(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]taskCandidate, 0, len(issues))
	for _, is := range issues {
		out = append(out, taskCandidate{
			id:        "jira:" + is.Key,
			kind:      kindJira,
			title:     is.Title,
			subtitle:  is.Key + " · " + is.Status,
			url:       is.URL,
			updatedAt: time.Now(), // Jira's own updated time isn't fetched (only status/summary/description)
			detail: jiraDetail{
				Key: is.Key, Status: is.Status, Description: is.Description, URL: is.URL,
			},
			signals: taskSignals{Kind: kindJira, JiraActive: isJiraActive(is.Status)},
		})
	}
	return out, nil
}

// isJiraActive reports whether a ticket's status counts as "actively being
// worked on" for the jira_active point rule — everything except Backlog/To
// Do (case-insensitive; the exact category taxonomy differs per Jira
// project, so this matches on the common status *names* rather than the
// statusCategory key).
func isJiraActive(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "", "backlog", "to do", "todo", "open":
		return false
	default:
		return true
	}
}
