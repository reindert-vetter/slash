// plan_comments.go — the READ half of the plan page's Jira comment panel:
// which comments exist around a ticket (its own, the main task's, and every
// subtask's), and who can be @-mentioned in a reply.
//
// Both endpoints are read-only and call nothing but modules/jira's own READ
// methods, which any caller may do (.claude/rules/workflows-write-boundary.md).
// Posting a reply is a real write and goes the sanctioned way instead: the
// `jira_comment` workflow (jira_comment.go).
//
// WHY A CACHE, AND WHY A WHOLE DAY: one cold fetch is up to
// maxCommentIssues+1 `acli` calls of several seconds each, and the page polls
// every 3s. The reviewer asked for a day ("api token, maar je mag het per dag
// cachen"), so the panel is served from memory until something explicitly asks
// for fresh data (`?refresh=1`, which the page sends right after posting a
// reply and behind the panel's own "Ververs"). Purely operational: an
// in-memory map, no module write, no read-model, no workflow history, empty
// again after a restart — the same carve-out auth_status.go's cached verdict
// documents. Jira itself stays the source of truth; this only decides how
// often we ask it.
//
// See .claude/docs/plan-page.md.
package main

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"slash/modules/jira"
)

// planCommentsTTL is how long a fetched panel stays good — one day, per the
// reviewer's own instruction. `?refresh=1` bypasses it.
const planCommentsTTL = 24 * time.Hour

// planUsersTTL bounds the @-mention lookup's own cache. Much shorter: it is
// one cheap REST call, and a colleague who joined today should be findable
// today.
const planUsersTTL = time.Hour

// maxCommentIssues bounds how many OTHER issues of the family are read for
// their comments — the same bound (and the same reason: one acli call each)
// as maxPlanContextIssues, kept separate so the panel and the prompt context
// can move apart later.
const maxCommentIssues = 5

// maxMentionResults bounds one @-mention lookup.
const maxMentionResults = 10

// planCommentGroup is one ticket's comments as the panel renders them.
type planCommentGroup struct {
	Key      string         `json:"key"`
	Title    string         `json:"title,omitempty"`
	URL      string         `json:"url,omitempty"`
	Relation string         `json:"relation"` // "self" | "parent" | "subtask"
	Comments []jira.Comment `json:"comments,omitempty"`
}

// planCommentsView is the whole payload of GET /api/jira/comments.
type planCommentsView struct {
	Groups    []planCommentGroup `json:"groups"`
	FetchedAt time.Time          `json:"fetchedAt"`
	// CanPost/CanMention say whether the Atlassian API token is configured at
	// all: without it a reply cannot be posted and no user can be searched, and
	// the panel says so in words rather than failing on send.
	CanPost    bool `json:"canPost"`
	CanMention bool `json:"canMention"`
}

type planCommentsCacheEntry struct {
	view planCommentsView
	at   time.Time
}

var (
	planCommentsMu    sync.Mutex
	planCommentsCache = map[string]planCommentsCacheEntry{}
	// planCommentsFlight is the single-flight guard: the page polls, and two
	// tabs on the same ticket must not each pay for six acli calls.
	planCommentsFlight = map[string]*sync.Mutex{}
)

type planUsersCacheEntry struct {
	users []jira.User
	at    time.Time
}

var (
	planUsersMu    sync.Mutex
	planUsersCache = map[string]planUsersCacheEntry{}
)

// planCommentFamily is the order the panel shows: this ticket first, then the
// main task, then the subtasks around it. Pure, so the ordering/deduplication
// is testable without a CLI.
func planCommentFamily(self jira.Issue) []planCommentGroup {
	out := []planCommentGroup{{Key: self.Key, Title: self.Title, URL: self.URL, Relation: "self", Comments: self.Comments}}
	seen := map[string]bool{strings.ToUpper(self.Key): true}
	add := func(key, title, relation string) {
		key = strings.ToUpper(strings.TrimSpace(key))
		if key == "" || seen[key] || len(out) > maxCommentIssues {
			return
		}
		seen[key] = true
		out = append(out, planCommentGroup{Key: key, Title: title, Relation: relation})
	}
	add(self.ParentKey, self.ParentTitle, "parent")
	for _, st := range self.Subtasks {
		add(st.Key, st.Title, "subtask")
	}
	return out
}

// PlanComments reads the whole panel for one ticket. cached=false forces a
// fresh read.
func (m *TaskManager) PlanComments(ctx context.Context, key string, fresh bool) (planCommentsView, error) {
	key = strings.ToUpper(strings.TrimSpace(key))
	if !fresh {
		planCommentsMu.Lock()
		entry, ok := planCommentsCache[key]
		planCommentsMu.Unlock()
		if ok && time.Since(entry.at) < planCommentsTTL {
			return entry.view, nil
		}
	}
	// Single-flight per ticket: whoever gets here first pays for the acli
	// calls, everyone else waits and then reads the cache that first one left.
	planCommentsMu.Lock()
	gate := planCommentsFlight[key]
	if gate == nil {
		gate = &sync.Mutex{}
		planCommentsFlight[key] = gate
	}
	planCommentsMu.Unlock()
	gate.Lock()
	defer gate.Unlock()
	if !fresh {
		planCommentsMu.Lock()
		entry, ok := planCommentsCache[key]
		planCommentsMu.Unlock()
		if ok && time.Since(entry.at) < planCommentsTTL {
			return entry.view, nil
		}
	}

	view := planCommentsView{Groups: []planCommentGroup{}, FetchedAt: time.Now().UTC()}
	email, token := jiraTokenConfigured()
	view.CanPost, view.CanMention = email, token
	if m == nil || m.jira == nil {
		return view, nil
	}
	self, err := m.jira.Issue(ctx, key)
	if err != nil {
		return view, err
	}
	if self.Key == "" {
		self.Key = key
	}
	groups := planCommentFamily(self)
	for i := range groups {
		if groups[i].Relation == "self" {
			continue
		}
		issue, err := m.jira.Issue(ctx, groups[i].Key)
		if err != nil {
			m.logf("plan comments: read %s: %v", groups[i].Key, err)
			continue
		}
		groups[i].Comments = issue.Comments
		if groups[i].Title == "" {
			groups[i].Title = issue.Title
		}
		groups[i].URL = issue.URL
	}
	view.Groups = groups
	planCommentsMu.Lock()
	planCommentsCache[key] = planCommentsCacheEntry{view: view, at: time.Now()}
	planCommentsMu.Unlock()
	return view, nil
}

// jiraTokenConfigured reports whether posting/searching is possible at all —
// both need the Atlassian API token, unlike reading (which goes through acli).
func jiraTokenConfigured() (post, mention bool) {
	email, token, _ := jiraCredsFromEnv()
	ok := email != "" && token != ""
	return ok, ok
}

// handlePlanComments serves GET /api/jira/comments?key=KEY[&refresh=1].
func (s *server) handlePlanComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("key")))
	if !planKeyPattern.MatchString(key) {
		http.Error(w, "invalid issue key", http.StatusBadRequest)
		return
	}
	view, err := s.tasks.manager.PlanComments(r.Context(), key, r.URL.Query().Get("refresh") == "1")
	payload := map[string]any{"ok": true, "key": key, "groups": view.Groups, "canPost": view.CanPost, "canMention": view.CanMention, "fetchedAt": view.FetchedAt}
	if err != nil {
		// Never an error wall: the panel shows the reason as a note, the same
		// "never cry wolf" rule the Jira sections follow.
		payload["error"] = err.Error()
	}
	writeJSON(w, http.StatusOK, payload)
}

// handleJiraUsers serves GET /api/jira/users?q=… — the @-mention picker.
// Read-only, and answered from a short-lived per-query cache.
func (s *server) handleJiraUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 100 {
		q = q[:100]
	}
	_, configured := jiraTokenConfigured()
	if q == "" || !configured || s.tasks.manager == nil || s.tasks.manager.jira == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "users": []jira.User{}, "configured": configured})
		return
	}
	ck := strings.ToLower(q)
	planUsersMu.Lock()
	entry, ok := planUsersCache[ck]
	planUsersMu.Unlock()
	if ok && time.Since(entry.at) < planUsersTTL {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "users": entry.users, "configured": true})
		return
	}
	users, err := s.tasks.manager.jira.Users(r.Context(), q, maxMentionResults)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "users": []jira.User{}, "configured": true, "error": err.Error()})
		return
	}
	if users == nil {
		users = []jira.User{}
	}
	planUsersMu.Lock()
	planUsersCache[ck] = planUsersCacheEntry{users: users, at: time.Now()}
	planUsersMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "users": users, "configured": true})
}

// invalidatePlanComments drops one ticket's cached panel, so the next read is
// fresh. Called after a reply was posted.
func invalidatePlanComments(key string) {
	key = strings.ToUpper(strings.TrimSpace(key))
	planCommentsMu.Lock()
	delete(planCommentsCache, key)
	planCommentsMu.Unlock()
}
