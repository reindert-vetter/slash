package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
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
	State     string `json:"state"` // APPROVED|CHANGES_REQUESTED|COMMENTED|DISMISSED|PENDING|UNKNOWN
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
	// NewSinceKind is set only when the PR's own updatedAt postdates the
	// logged-in reviewer's OWN last comment/review on it: "comment" or
	// "review" (never both — whichever of the two was more recent). Empty
	// when the reviewer never commented/reviewed, or when nothing happened
	// since. See myLastActivity's doc comment for exactly what counts.
	NewSinceKind string `json:"newSinceKind,omitempty"`
	// NewSinceAt is the timestamp NewSinceKind refers to: the reviewer's OWN
	// last comment/review on this PR (myLastActivity's `at`), empty whenever
	// NewSinceKind is. The overview only needs the kind word, but the review
	// tree's "sinds jouw laatste review" block needs the moment itself to say
	// WHAT changed since — and it must be the very same moment, not a second
	// approximation next to it, so it is carried here rather than recomputed.
	NewSinceAt string `json:"newSinceAt,omitempty"`
	// UpdatedAt is the PR's own GitHub updatedAt, the timestamp behind the
	// overview's "Bijgewerkt … geleden". Carried along for the same reason as
	// NewSinceAt: the review tree renders that exact line and has no other
	// source for it (prmeta's own updated_at is the local write time).
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// inboxRow is one PR in the inbox. The status fields carry the heavy data and
// are only populated for the search endpoint (the inbox itself backfills them
// separately); they are omitted from the light payload.
type inboxRow struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Author    string `json:"author"`
	UpdatedAt string `json:"updatedAt"`
	// CreatedAt is used by the task-inbox "pr_aging" point rule (see
	// taskinbox_analysis.go) to tell how long a PR has been open/waiting for
	// review — the same 3-day threshold the "ouder-3-dagen" filter preset
	// uses, but read here as a plain field instead of a gh search qualifier.
	// Empty for an older fixture that predates this field (treated as
	// "unknown age", never triggers the aging rule).
	CreatedAt    string `json:"createdAt,omitempty"`
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
	CreatedAt    string `json:"createdAt"`
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
		// Nodes is only requested on the heavy query (see heavyFields) — the
		// last N conversation comments, used to find the reviewer's own last
		// one for the "new since your comment" signal (myLastActivity).
		Nodes []struct {
			Author struct {
				Login string `json:"login"`
			} `json:"author"`
			CreatedAt string `json:"createdAt"`
		} `json:"nodes"`
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
	// Reviews is the FULL review history (capped at reviewsPerPRCap), used to
	// fold each reviewer's DECISIVE state (see mergeReviewers) instead of
	// just their literal latest review. PageInfo.HasNextPage signals that
	// the PR has more review submissions than we fetched.
	Reviews struct {
		PageInfo struct {
			HasNextPage bool `json:"hasNextPage"`
		} `json:"pageInfo"`
		Nodes []reviewNode `json:"nodes"`
	} `json:"reviews"`
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

// lightFields deliberately omits `comments`: the light query only draws the
// first-paint row, and the "💬 n" badge is overwritten right after anyway (see
// pr.Comments = open in refreshInbox, workflows.go) — the raw GitHub count is
// never actually shown. The heavy query below adds it back WITH nodes, since
// that's also where myLastActivity needs the reviewer's own comment authors.
const lightFields = `
	number title url updatedAt createdAt isDraft state baseRefName headRefName
	additions deletions changedFiles author { login }`

// reviewsPerPRCap is the `first:` cap on the `reviews` connection below.
// statusesFor batches EVERY inbox PR into one aliased query, so this cap
// multiplies directly by however many PRs are in view — deliberately kept
// modest (matching the existing reviewRequests/latestReviews cap of 30,
// bumped up a bit since a PR's review-submission COUNT churns faster than
// its reviewer count: one reviewer commonly submits several rounds). See
// mergeReviewers' own doc comment for what happens once a PR exceeds it.
const reviewsPerPRCap = 50

// myCommentsCap is the `last:` cap on the `comments` connection in heavyFields
// — only used to find the reviewer's OWN most recent conversation comment
// (myLastActivity), not to render every comment. A reviewer whose own last
// comment is older than the last 20 conversation comments on a PR (i.e. lots
// of back-and-forth happened after it) simply won't trigger the "new since
// your comment" signal from that comment — the PR's `updatedAt` already
// implies something happened, which is the strictly-worse fallback (no
// signal shown) rather than a wrong one.
const myCommentsCap = 20

// stateUnknown marks a reviewer whose decisive state we could not reliably
// determine because their review history was truncated by reviewsPerPRCap
// (see mergeReviewers). reviewerAvatar (src/overview.mjs) doesn't special-case
// it — it already renders any state outside {APPROVED,CHANGES_REQUESTED,
// COMMENTED} as a plain, dimmed placeholder, which is exactly the "we don't
// know" visual this deserves. Only its label (STATE_LABEL) needed a line.
const stateUnknown = "UNKNOWN"

// reviewNode is one entry of the `reviews` connection — the raw event that
// foldReviewerStates walks per author, in submission order.
type reviewNode struct {
	State       string `json:"state"`
	SubmittedAt string `json:"submittedAt"`
	Author      struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatarUrl"`
	} `json:"author"`
}

var heavyFields = fmt.Sprintf(`
	comments(last: %d) { totalCount nodes { author { login } createdAt } }
	mergeable reviewDecision
	reviewRequests(first: 30) { nodes { requestedReviewer {
		__typename ... on User { login avatarUrl } ... on Team { name } } } }
	latestReviews(first: 30) { nodes { state author { login ... on User { avatarUrl } } } }
	reviews(first: %d) { pageInfo { hasNextPage } nodes {
		state submittedAt author { login ... on User { avatarUrl } } } }
	commits(last: 1) { nodes { commit { statusCheckRollup {
		state contexts { totalCount } } } } }`, myCommentsCap, reviewsPerPRCap)

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
	return runPRSearch(ctx, expr+" sort:updated-desc", light)
}

// searchPRsExpr runs a search whose expr already carries its own sort: (and any
// draft:/state: qualifiers) — used by the preset filters (handleFilter), where
// the caller must control the ordering, unlike searchPRs which always appends
// sort:updated-desc. repo:<slug> is still prepended here (never trust the caller
// with the repo scope).
func searchPRsExpr(ctx context.Context, expr string, light bool) ([]inboxRow, error) {
	return runPRSearch(ctx, expr, light)
}

// runPRSearch is the shared gh-search core: it prepends repo:<slug> and runs the
// GraphQL search, mapping nodes to rows. The caller owns everything after the
// repo scope (including sort:).
func runPRSearch(ctx context.Context, expr string, light bool) ([]inboxRow, error) {
	fields := lightFields
	if !light {
		fields = lightFields + heavyFields
	}
	query := fmt.Sprintf(`query ($q: String!, $n: Int!) {
		search(query: $q, type: ISSUE, first: $n) {
			nodes { ... on PullRequest { %s } }
		}
	}`, fields)
	full := "repo:" + repoSlug + " " + expr
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
	login := ghLogin(ctx)
	rows := make([]inboxRow, 0, len(parsed.Search.Nodes))
	for _, n := range parsed.Search.Nodes {
		rows = append(rows, mapPRNode(n, !light, login))
	}
	return rows, nil
}

// mapPRNode turns a GraphQL node into a row; heavy fills the status fields.
func mapPRNode(n ghPRNode, heavy bool, login string) inboxRow {
	r := inboxRow{
		Number:       n.Number,
		Title:        n.Title,
		Author:       n.Author.Login,
		UpdatedAt:    n.UpdatedAt,
		CreatedAt:    n.CreatedAt,
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
		st := statusFromNode(n, login)
		r.Mergeable = st.Mergeable
		r.ReviewDecision = st.ReviewDecision
		r.Reviewers = st.Reviewers
		r.ChecksState = st.ChecksState
		r.ChecksTotal = st.ChecksTotal
	}
	return r
}

// statusFromNode extracts the heavy status from a full node. login is the
// logged-in reviewer (ghLogin) — used only for myLastActivity.
func statusFromNode(n ghPRNode, login string) prStatus {
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
	st.UpdatedAt = n.UpdatedAt
	if at, kind := myLastActivity(n, login); at != "" && afterRFC3339(n.UpdatedAt, at) {
		st.NewSinceKind = kind
		st.NewSinceAt = at
	}
	return st
}

// myLastActivity finds the logged-in reviewer's own most recent comment/review
// on this PR — the later of: their last conversation comment (`comments`,
// capped at myCommentsCap) and their last review submission (`reviews`, any
// state — APPROVED/CHANGES_REQUESTED/COMMENTED all count as "you said
// something"). Returns ("", "") if the reviewer never did either.
//
// Deliberately does NOT separately query inline review comments: a single
// inline comment (with or without "start a review") is always submitted as
// part of a review in GitHub's data model, so its timestamp already surfaces
// here via `reviews[].submittedAt` — a second, per-review `comments`
// sub-connection would add real query cost (reviewsPerPRCap reviews × N
// comments, per PR, batched across every visible PR in statusesFor) for
// exactly the timestamp we already have.
func myLastActivity(n ghPRNode, login string) (at, kind string) {
	if login == "" || login == "me" {
		return "", ""
	}
	for _, rv := range n.Reviews.Nodes {
		if rv.Author.Login != login || rv.SubmittedAt == "" {
			continue
		}
		if at == "" || afterRFC3339(rv.SubmittedAt, at) {
			at, kind = rv.SubmittedAt, "review"
		}
	}
	for _, c := range n.Comments.Nodes {
		if c.Author.Login != login || c.CreatedAt == "" {
			continue
		}
		if at == "" || afterRFC3339(c.CreatedAt, at) {
			at, kind = c.CreatedAt, "comment"
		}
	}
	return at, kind
}

// afterRFC3339 reports whether RFC3339 timestamp a is strictly after b. An
// unparsable timestamp on either side is treated as "not after" (defensive —
// shouldn't happen for a real GitHub API response).
func afterRFC3339(a, b string) bool {
	ta, ea := time.Parse(time.RFC3339, a)
	tb, eb := time.Parse(time.RFC3339, b)
	if ea != nil || eb != nil {
		return false
	}
	return ta.After(tb)
}

// reviewerFold is the outcome of folding one author's reviews (in submission
// order) into a single status: `decisive` is the last APPROVED/
// CHANGES_REQUESTED seen (cleared by a DISMISSED — see foldReviewerStates),
// `lastSeenRaw` is the literal state of the very last review we saw for that
// author in our (possibly truncated) window, whatever its type. `lastSeenRaw`
// exists only for the truncation cross-check in mergeReviewers, never shown
// directly.
type reviewerFold struct {
	decisive    string
	lastSeenRaw string
}

// effective is the state actually shown for a reviewer once the fold is
// trusted: the decisive state if we ever saw one, otherwise whatever their
// last (non-decisive, e.g. COMMENTED) review was.
func (f reviewerFold) effective() string {
	if f.decisive != "" {
		return f.decisive
	}
	return f.lastSeenRaw
}

// foldReviewerStates walks a PR's review nodes in submission order and folds
// them into one reviewerFold per author.
//
// GitHub's own reviewDecision (and the PR sidebar's per-reviewer checkmark)
// never treats a COMMENTED review as revoking an earlier APPROVED/
// CHANGES_REQUESTED — only a later APPROVED, CHANGES_REQUESTED, or an
// explicit DISMISSED does that:
//   - APPROVED / CHANGES_REQUESTED replace the tracked decisive state.
//   - DISMISSED clears it. This is directly visible in the data, not
//     something we have to infer from a separate "dismissal event": GitHub
//     literally flips a dismissed review's own `state` field to DISMISSED (it
//     doesn't delete the review or hide it from `reviews`) — confirmed
//     against the live GraphQL schema (PullRequestReviewState.DISMISSED,
//     "A review that has been dismissed."). So a DISMISSED node in this same
//     list is exactly the dismissal signal, at whatever point in the
//     timeline it occurred.
//   - COMMENTED (or anything else, e.g. a stray PENDING) never changes the
//     decisive state, but still updates `lastSeenRaw` — needed by the
//     truncation cross-check in mergeReviewers.
//
// The nodes are sorted defensively by `submittedAt` rather than trusted to
// already arrive in that order — the GraphQL schema documents no explicit
// ordering guarantee for this connection, even though it has been observed
// to return oldest-first in practice. An unparsable timestamp (shouldn't
// happen for a real API response) leaves that pair's relative order
// untouched (stable sort).
func foldReviewerStates(nodes []reviewNode) map[string]reviewerFold {
	sorted := make([]reviewNode, len(nodes))
	copy(sorted, nodes)
	sort.SliceStable(sorted, func(i, j int) bool {
		ti, ei := time.Parse(time.RFC3339, sorted[i].SubmittedAt)
		tj, ej := time.Parse(time.RFC3339, sorted[j].SubmittedAt)
		if ei != nil || ej != nil {
			return false
		}
		return ti.Before(tj)
	})
	out := map[string]reviewerFold{}
	for _, rv := range sorted {
		login := rv.Author.Login
		if login == "" {
			continue
		}
		f := out[login]
		switch rv.State {
		case "APPROVED", "CHANGES_REQUESTED":
			f.decisive = rv.State
		case "DISMISSED":
			f.decisive = ""
		}
		f.lastSeenRaw = rv.State
		out[login] = f
	}
	return out
}

// mergeReviewers starts from who gave a latest review — folded to their
// DECISIVE state via foldReviewerStates, not their literal latest review —
// then overwrites with open review requests → PENDING (a re-request wins over
// an old review). A reviewer with only a team name is a team.
//
// Why folding instead of just `latestReviews[i].State` (the previous
// implementation): `latestReviews` returns literally "the very last review
// submitted, whatever its type" — so a reviewer who approved and then left
// one more plain comment showed up as merely "commented", even though GitHub
// itself (reviewDecision, the PR sidebar's checkmark) still counted them as
// approved. Reproduced live against plug-and-pay PR 13168: reindert-vetter
// APPROVED at 09:19, then COMMENTED at 09:24 — GitHub kept showing him as
// approved, we didn't.
//
// Pagination truncation (reviewsPerPRCap, see its own doc comment): `reviews`
// is fetched oldest-first, so once a PR has more submissions than the cap,
// exactly the NEWEST reviews — the ones a fold needs most — are the ones
// missing. Rather than risk silently showing a stale approval (or a stale
// non-approval, if a later CHANGES_REQUESTED/DISMISSED got cut off), each
// author's fold is cross-checked against `latestReviews` — a SEPARATE field
// GitHub computes for us as an aggregate, unaffected by our own `reviews`
// pagination cap: if the last review we actually saw for that author matches
// their true latest review, our window captured everything relevant to them
// and the fold is trusted; if it doesn't match (or we have no fold data for
// them at all), our window is missing something and we show `stateUnknown`
// instead of a guess. This can only ever fire when `reviews.pageInfo.
// hasNextPage` is true — the ground truth is used unconditionally when the
// whole PR's review history fit within the cap.
func mergeReviewers(n ghPRNode) []reviewer {
	fold := foldReviewerStates(n.Reviews.Nodes)
	truncated := n.Reviews.PageInfo.HasNextPage

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
		state := lr.State
		f, ok := fold[lr.Author.Login]
		switch {
		case !truncated:
			// Complete data: trust the fold outright — it's strictly more
			// informative than the raw latest-review state we're replacing.
			if ok {
				state = f.effective()
			}
		case ok && f.lastSeenRaw == lr.State:
			// Truncated overall, but nothing was cut off for THIS author —
			// their true latest review is the one our window also saw last.
			state = f.effective()
		default:
			// Truncated, and this author's window disagrees with (or is
			// missing from) the ground truth: we can't tell whether a
			// decisive event beyond our cap changed their status.
			state = stateUnknown
		}
		put(reviewer{Login: lr.Author.Login, AvatarURL: lr.Author.AvatarURL, State: state})
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
		// updatedAt is requested here directly (not via lightFields, which
		// this query otherwise skips) — myLastActivity/afterRFC3339 need it
		// to decide whether anything happened since the reviewer's own last
		// comment/review.
		b.WriteString(fmt.Sprintf("  pr%d: pullRequest(number: %d) { number state updatedAt %s }\n", num, num, heavyFields))
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
	login := ghLogin(ctx)
	out := map[string]prStatus{}
	for _, n := range parsed.Repository {
		if n.Number == 0 {
			continue
		}
		out[strconv.Itoa(n.Number)] = statusFromNode(n, login)
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
