package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// inbox.go is the read-only GitHub bridge behind the /pr-overview inbox. It
// shells out to `gh api graphql` to list the PRs that need your attention,
// grouped in sections that mirror github.com/pulls. It never mutates state —
// per the write-boundary rule the overview is purely a read model; the only
// write action (ingest) lives elsewhere.
//
// Two levels of detail keep the first paint fast: a LIGHT query draws each row
// (title/author/branch/diff), and a heavier per-PR status backfill fills the
// review/CI pills afterwards without the row jumping.
//
// Offline/testing: when SLASH_GITHUB=off we never touch the network; instead we
// read a fixture pointed at by SLASH_INBOX (see tests/fixtures/inbox.json). The
// client's own fallback to /data/inbox.json covers a real gh outage.

// reviewer is one requested/actual reviewer on a PR, merged from reviewRequests
// and latestReviews.
type reviewer struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
	State     string `json:"state"` // APPROVED|CHANGES_REQUESTED|COMMENTED|DISMISSED|PENDING
	Team      bool   `json:"team"`
}

// prStatus is the heavy status backfill for one PR (GET /api/inbox/status).
type prStatus struct {
	Mergeable      string     `json:"mergeable"`      // MERGEABLE|CONFLICTING|UNKNOWN
	ReviewDecision string     `json:"reviewDecision"` // APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|""
	State          string     `json:"state"`          // OPEN|MERGED|CLOSED
	Reviewers      []reviewer `json:"reviewers"`
	ChecksState    string     `json:"checksState"` // SUCCESS|FAILURE|PENDING|EXPECTED|ERROR|""
	ChecksTotal    int        `json:"checksTotal"`
}

// inboxRow is one PR in the inbox. The status fields carry the heavy data and
// are only populated for the search endpoint (the inbox itself backfills them
// separately); they are omitted from the light payload.
type inboxRow struct {
	Number       int    `json:"number"`
	Title        string `json:"title"`
	Author       string `json:"author"`
	UpdatedAt    string `json:"updatedAt"`
	URL          string `json:"url"`
	IsDraft      bool   `json:"isDraft"`
	BaseRefName  string `json:"baseRefName"`
	HeadRefName  string `json:"headRefName"`
	Additions    int    `json:"additions"`
	Deletions    int    `json:"deletions"`
	ChangedFiles int    `json:"changedFiles"`
	Comments     int    `json:"comments"`
	HasGraph     bool   `json:"hasGraph"`

	Mergeable      string     `json:"mergeable,omitempty"`
	ReviewDecision string     `json:"reviewDecision,omitempty"`
	Reviewers      []reviewer `json:"reviewers,omitempty"`
	ChecksState    string     `json:"checksState,omitempty"`
	ChecksTotal    int        `json:"checksTotal,omitempty"`
}

// inboxSection is a titled bucket of rows, mirroring a github.com/pulls group.
type inboxSection struct {
	Title string     `json:"title"`
	PRs   []inboxRow `json:"prs"`
}

// inboxFixture is the offline snapshot shape (SLASH_INBOX / data/inbox.json).
type inboxFixture struct {
	Repo         string              `json:"repo"`
	GeneratedFor string              `json:"generatedFor"`
	Sections     []inboxSection      `json:"sections"`
	Statuses     map[string]prStatus `json:"statuses"`
}

// queryDef is one GitHub search string feeding a section. keep, when set, filters
// that query's hits after the fact (e.g. the COMMENTED catch); light:false forces
// the heavy query so keep can inspect reviewers.
type queryDef struct {
	q     string
	light bool
	keep  func(r inboxRow, login string) bool
}

// sectionDef defines a section and the queries that fill it. A PR lands in the
// first section (and first query) it matches; later sections drop duplicates.
type sectionDef struct {
	title   string
	queries []queryDef
}

// inboxSections mirror GitHub's /pulls dashboard. @me is resolved by gh itself.
// The qualifiers are ported verbatim from the battle-tested dash inbox
// (serve.mjs INBOX_SECTIONS): repo:<slug> is prepended and sort:updated-desc
// appended per query (see searchPRs).
var inboxSections = []sectionDef{
	{title: "Ready to merge", queries: []queryDef{
		{q: "is:pr author:@me state:open -is:draft review:approved -review:changes_requested -status:failure -is:queued archived:false"},
	}},
	{title: "Needs action", queries: []queryDef{
		{q: "is:pr author:@me state:open review:changes_requested archived:false -is:draft"},
		{q: "is:pr author:@me state:open status:failure archived:false -is:draft"},
		{q: "is:pr -is:closed archived:false author:@copilot assignee:@me (status:failure OR review:changes_requested) -is:draft"},
		{q: "is:pr author:@me state:open review:required comments:>0 archived:false -is:draft"},
	}},
	{title: "Waiting for review or checks", queries: []queryDef{
		{q: "is:pr author:@me state:open -is:draft archived:false -review:approved -review:changes_requested -status:failure"},
	}},
	{title: "Your drafts", queries: []queryDef{
		{q: "is:pr author:@me is:draft state:open archived:false"},
	}},
	{title: "Needs your team's review", queries: []queryDef{
		{q: "is:pr team-review-requested-user:@me state:open archived:false"},
	}},
	{title: "Needs your review", queries: []queryDef{
		{q: "is:pr user-review-requested:@me state:open archived:false"},
		// GitHub drops you from user-review-requested once you submit ANY review,
		// including a comment-only one. Re-catch those where your latest review is
		// only COMMENTED so an in-progress review does not vanish. light:false so
		// reviewers is populated for the keep filter even on the fast first paint.
		{q: "is:pr reviewed-by:@me state:open archived:false -author:@me", light: false, keep: func(r inboxRow, login string) bool {
			for _, rv := range r.Reviewers {
				if rv.Login == login {
					return rv.State == "COMMENTED"
				}
			}
			return false
		}},
	}},
}

const inboxLimit = 40

// ghLoginCache memoises the logged-in gh user for the process.
var (
	ghLoginOnce sync.Once
	ghLoginVal  string
)

// ghLogin returns the logged-in gh user (cached). Falls back to "me" on error.
func ghLogin(ctx context.Context) string {
	ghLoginOnce.Do(func() {
		out, err := exec.CommandContext(ctx, "gh", "api", "user", "--jq", ".login").Output()
		if err != nil {
			ghLoginVal = "me"
			return
		}
		ghLoginVal = strings.TrimSpace(string(out))
		if ghLoginVal == "" {
			ghLoginVal = "me"
		}
	})
	return ghLoginVal
}

// --- GraphQL node shapes -----------------------------------------------------

type ghPRNode struct {
	Number       int    `json:"number"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	UpdatedAt    string `json:"updatedAt"`
	IsDraft      bool   `json:"isDraft"`
	State        string `json:"state"`
	BaseRefName  string `json:"baseRefName"`
	HeadRefName  string `json:"headRefName"`
	Additions    int    `json:"additions"`
	Deletions    int    `json:"deletions"`
	ChangedFiles int    `json:"changedFiles"`
	Author       struct {
		Login string `json:"login"`
	} `json:"author"`
	Comments struct {
		TotalCount int `json:"totalCount"`
	} `json:"comments"`
	// heavy fields (full query only)
	Mergeable      string `json:"mergeable"`
	ReviewDecision string `json:"reviewDecision"`
	ReviewRequests struct {
		Nodes []struct {
			RequestedReviewer struct {
				Typename  string `json:"__typename"`
				Login     string `json:"login"`
				AvatarURL string `json:"avatarUrl"`
				Name      string `json:"name"`
			} `json:"requestedReviewer"`
		} `json:"nodes"`
	} `json:"reviewRequests"`
	LatestReviews struct {
		Nodes []struct {
			State  string `json:"state"`
			Author struct {
				Login     string `json:"login"`
				AvatarURL string `json:"avatarUrl"`
			} `json:"author"`
		} `json:"nodes"`
	} `json:"latestReviews"`
	Commits struct {
		Nodes []struct {
			Commit struct {
				StatusCheckRollup *struct {
					State    string `json:"state"`
					Contexts struct {
						TotalCount int `json:"totalCount"`
					} `json:"contexts"`
				} `json:"statusCheckRollup"`
			} `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
}

const lightFields = `
	number title url updatedAt isDraft state baseRefName headRefName
	additions deletions changedFiles author { login } comments { totalCount }`

const heavyFields = `
	mergeable reviewDecision
	reviewRequests(first: 30) { nodes { requestedReviewer {
		__typename ... on User { login avatarUrl } ... on Team { name } } } }
	latestReviews(first: 30) { nodes { state author { login ... on User { avatarUrl } } } }
	commits(last: 1) { nodes { commit { statusCheckRollup {
		state contexts { totalCount } } } } }`

// ghGraphQL runs a gh GraphQL query with -f/-F variables and returns the raw
// data body. Variables are passed as separate args (no shell interpolation).
func ghGraphQL(ctx context.Context, query string, vars ...string) (json.RawMessage, error) {
	args := append([]string{"api", "graphql", "-f", "query=" + query}, vars...)
	out, err := exec.CommandContext(ctx, "gh", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("gh api graphql: %w", err)
	}
	var resp struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, fmt.Errorf("parse graphql: %w", err)
	}
	return resp.Data, nil
}

// searchPRs runs one GitHub search and maps the nodes to rows.
func searchPRs(ctx context.Context, expr string, light bool) ([]inboxRow, error) {
	fields := lightFields
	if !light {
		fields = lightFields + heavyFields
	}
	query := fmt.Sprintf(`query ($q: String!, $n: Int!) {
		search(query: $q, type: ISSUE, first: $n) {
			nodes { ... on PullRequest { %s } }
		}
	}`, fields)
	full := "repo:" + repoSlug + " " + expr + " sort:updated-desc"
	data, err := ghGraphQL(ctx, query, "-f", "q="+full, "-F", "n="+strconv.Itoa(inboxLimit))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Search struct {
			Nodes []ghPRNode `json:"nodes"`
		} `json:"search"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("parse search nodes: %w", err)
	}
	rows := make([]inboxRow, 0, len(parsed.Search.Nodes))
	for _, n := range parsed.Search.Nodes {
		rows = append(rows, mapPRNode(n, !light))
	}
	return rows, nil
}

// mapPRNode turns a GraphQL node into a row; heavy fills the status fields.
func mapPRNode(n ghPRNode, heavy bool) inboxRow {
	r := inboxRow{
		Number:       n.Number,
		Title:        n.Title,
		Author:       n.Author.Login,
		UpdatedAt:    n.UpdatedAt,
		URL:          n.URL,
		IsDraft:      n.IsDraft,
		BaseRefName:  n.BaseRefName,
		HeadRefName:  n.HeadRefName,
		Additions:    n.Additions,
		Deletions:    n.Deletions,
		ChangedFiles: n.ChangedFiles,
		Comments:     n.Comments.TotalCount,
	}
	if heavy {
		st := statusFromNode(n)
		r.Mergeable = st.Mergeable
		r.ReviewDecision = st.ReviewDecision
		r.Reviewers = st.Reviewers
		r.ChecksState = st.ChecksState
		r.ChecksTotal = st.ChecksTotal
	}
	return r
}

// statusFromNode extracts the heavy status from a full node.
func statusFromNode(n ghPRNode) prStatus {
	st := prStatus{
		Mergeable:      n.Mergeable,
		ReviewDecision: n.ReviewDecision,
		State:          n.State,
		Reviewers:      mergeReviewers(n),
	}
	if len(n.Commits.Nodes) > 0 {
		if roll := n.Commits.Nodes[0].Commit.StatusCheckRollup; roll != nil {
			st.ChecksState = roll.State
			st.ChecksTotal = roll.Contexts.TotalCount
		}
	}
	return st
}

// mergeReviewers starts from who gave a latest review (state = their review),
// then overwrites with open review requests → PENDING (a re-request wins over an
// old review). A reviewer with only a team name is a team.
func mergeReviewers(n ghPRNode) []reviewer {
	byKey := map[string]reviewer{}
	order := []string{}
	put := func(rv reviewer) {
		key := rv.Login
		if rv.Team {
			key = "team:" + rv.Login
		}
		if _, seen := byKey[key]; !seen {
			order = append(order, key)
		}
		byKey[key] = rv
	}
	for _, lr := range n.LatestReviews.Nodes {
		if lr.Author.Login == "" {
			continue
		}
		put(reviewer{Login: lr.Author.Login, AvatarURL: lr.Author.AvatarURL, State: lr.State})
	}
	for _, rr := range n.ReviewRequests.Nodes {
		rq := rr.RequestedReviewer
		if rq.Typename == "Team" || (rq.Login == "" && rq.Name != "") {
			put(reviewer{Login: rq.Name, Team: true, State: "PENDING"})
			continue
		}
		if rq.Login == "" {
			continue
		}
		put(reviewer{Login: rq.Login, AvatarURL: rq.AvatarURL, State: "PENDING"})
	}
	out := make([]reviewer, 0, len(order))
	for _, k := range order {
		out = append(out, byKey[k])
	}
	return out
}

// buildInbox runs every section's queries, de-dupes within and across sections
// (first match wins), and overlays hasGraph from the DB. Queries run in parallel.
func buildInbox(ctx context.Context, db *sql.DB) ([]inboxSection, error) {
	login := ghLogin(ctx)

	// Flatten queries so they can run concurrently, then reassemble in order.
	type qref struct{ sec, q int }
	var refs []qref
	for si, s := range inboxSections {
		for qi := range s.queries {
			refs = append(refs, qref{si, qi})
		}
	}
	results := make([][]inboxRow, len(refs))
	errs := make([]error, len(refs))
	var wg sync.WaitGroup
	for i, ref := range refs {
		wg.Add(1)
		go func(i int, ref qref) {
			defer wg.Done()
			qd := inboxSections[ref.sec].queries[ref.q]
			rows, err := searchPRs(ctx, qd.q, qd.light)
			if err != nil {
				errs[i] = err
				return
			}
			if qd.keep != nil {
				kept := rows[:0]
				for _, r := range rows {
					if qd.keep(r, login) {
						kept = append(kept, r)
					}
				}
				rows = kept
			}
			results[i] = rows
		}(i, ref)
	}
	wg.Wait()

	// If every query failed, treat the whole build as failed (client falls back).
	anyOK := false
	for _, e := range errs {
		if e == nil {
			anyOK = true
			break
		}
	}
	if !anyOK {
		return nil, fmt.Errorf("all inbox queries failed: %v", errs[0])
	}

	ingested, _ := ingestedSet(db) // best-effort; hasGraph just stays false on error

	seen := map[int]bool{} // cross-section de-dupe
	byRef := map[qref][]inboxRow{}
	for i, ref := range refs {
		byRef[ref] = results[i]
	}
	sections := make([]inboxSection, 0, len(inboxSections))
	for si, sdef := range inboxSections {
		var rows []inboxRow
		local := map[int]bool{}
		for qi := range sdef.queries {
			for _, r := range byRef[qref{si, qi}] {
				if seen[r.Number] || local[r.Number] {
					continue
				}
				local[r.Number] = true
				r.HasGraph = ingested[r.Number]
				rows = append(rows, r)
			}
		}
		for _, r := range rows {
			seen[r.Number] = true
		}
		sections = append(sections, inboxSection{Title: sdef.title, PRs: rows})
	}
	return sections, nil
}

// statusesFor fetches the heavy status of several PRs in one aliased query.
func statusesFor(ctx context.Context, numbers []int) (map[string]prStatus, error) {
	if len(numbers) == 0 {
		return map[string]prStatus{}, nil
	}
	owner, name := splitRepo(repoSlug)
	var b strings.Builder
	b.WriteString(fmt.Sprintf("query {\n repository(owner: %q, name: %q) {\n", owner, name))
	for _, num := range numbers {
		b.WriteString(fmt.Sprintf("  pr%d: pullRequest(number: %d) { number state %s }\n", num, num, heavyFields))
	}
	b.WriteString(" }\n}")

	data, err := ghGraphQL(ctx, b.String())
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Repository map[string]ghPRNode `json:"repository"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("parse statuses: %w", err)
	}
	out := map[string]prStatus{}
	for _, n := range parsed.Repository {
		if n.Number == 0 {
			continue
		}
		out[strconv.Itoa(n.Number)] = statusFromNode(n)
	}
	return out, nil
}

func splitRepo(slug string) (owner, name string) {
	if i := strings.IndexByte(slug, '/'); i >= 0 {
		return slug[:i], slug[i+1:]
	}
	return slug, ""
}

// ingestedSet returns the set of PR numbers that have blocks (hasGraph=true).
func ingestedSet(db *sql.DB) (map[int]bool, error) {
	rows, err := db.Query(`SELECT DISTINCT pr FROM blocks`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]bool{}
	for rows.Next() {
		var pr int
		if err := rows.Scan(&pr); err != nil {
			return nil, err
		}
		out[pr] = true
	}
	return out, rows.Err()
}

// --- offline fixture ---------------------------------------------------------

// ghDisabled reports whether we must avoid the network (tests / no gh).
func ghDisabled() bool { return os.Getenv("SLASH_GITHUB") == "off" }

// loadFixture reads the SLASH_INBOX snapshot, if configured.
func loadFixture() (*inboxFixture, bool) {
	path := os.Getenv("SLASH_INBOX")
	if path == "" {
		return nil, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var f inboxFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, false
	}
	if f.Repo == "" {
		f.Repo = repoSlug
	}
	return &f, true
}

// fixtureRows flattens every row across a fixture's sections.
func fixtureRows(f *inboxFixture) []inboxRow {
	var out []inboxRow
	for _, s := range f.Sections {
		out = append(out, s.PRs...)
	}
	return out
}

// snapshotResult is the freshly fetched inbox, ready to persist in the module.
type snapshotResult struct {
	GeneratedFor string
	Sections     []inboxSection
	Statuses     map[string]prStatus
}

// buildInboxSnapshot fetches the current inbox from GitHub (or the fixture under
// SLASH_GITHUB=off) and its per-PR statuses, overlaying hasGraph from the DB.
// This is the one place the pr_inbox Activity reaches GitHub; the HTTP handlers
// only ever read the persisted read-model.
func buildInboxSnapshot(ctx context.Context, db *sql.DB) (*snapshotResult, error) {
	if ghDisabled() {
		f, ok := loadFixture()
		if !ok {
			return nil, fmt.Errorf("inbox: no fixture (SLASH_INBOX) while gh disabled")
		}
		for i := range f.Sections {
			overlayGraph(db, f.Sections[i].PRs)
		}
		return &snapshotResult{
			GeneratedFor: f.GeneratedFor,
			Sections:     f.Sections,
			Statuses:     f.Statuses,
		}, nil
	}

	sections, err := buildInbox(ctx, db)
	if err != nil {
		return nil, err
	}
	var numbers []int
	for _, s := range sections {
		for _, p := range s.PRs {
			numbers = append(numbers, p.Number)
		}
	}
	statuses, err := statusesFor(ctx, numbers)
	if err != nil {
		// A status failure is non-fatal — serve the rows, skip the pills.
		statuses = map[string]prStatus{}
	}
	return &snapshotResult{
		GeneratedFor: ghLogin(ctx),
		Sections:     sections,
		Statuses:     statuses,
	}, nil
}
