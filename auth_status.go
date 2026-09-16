package main

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"slash/modules/jira"
)

// auth_status.go answers one question the app could not answer before: "are the
// local CLIs and tokens this dashboard runs on still authenticated?"
//
// Everything slash does on the reviewer's behalf goes through a local
// credential — `gh` for every GitHub read/write, `acli` for the Jira issue
// lookup in the pr_status tracker, and an Atlassian API token for the Jira
// notification feed (modules/jira/notifications.go). When one of them expires,
// nothing crashes: the affected work is skipped and the reason only ever
// reaches a log line ("pr_status: fetch jira INTEG-620 skipped: …"), which the
// reviewer never reads. That is exactly the "iets groots gaat fout" case the
// global popup in src/authStatus.mjs exists for, and this endpoint is its only
// data source.
//
// WRITE BOUNDARY: GET /api/auth/status writes nothing durable — it shells out
// to two read-only status commands and keeps the outcome in one in-memory
// struct that is empty again after a restart. That is the same operational
// carve-out as /api/me, ingest_progress.go and the heartbeat map; see
// .claude/rules/workflows-write-boundary.md. The FIX for a failing check is a
// real write and goes the sanctioned way: the settings page signals the
// app_settings tracker (Kind "jiraCreds"), or the reviewer runs the named
// command in their own terminal.
//
// Deliberately NOT checked: `claude`. It has no queryable auth-status command
// (no `claude auth status`), so the only way to know is to make a real,
// billable call — too expensive for a poll, and a failing Claude call already
// surfaces as a genuinely failed workflow run in the failed-tasks popup.

// authCheckTimeout bounds one status subprocess. Same reasoning as
// jira.cliTimeout: this runs inside an HTTP request, and a CLI that decides to
// prompt interactively (no TTY to answer it) would otherwise hang forever.
var authCheckTimeout = 10 * time.Second

// authStatusTTL is how long a computed status is reused. The popup polls, and
// shelling out twice per minute per tab would be silly; the "Opnieuw
// controleren" button bypasses this with ?refresh=1, which is the whole point
// of that button.
const authStatusTTL = 60 * time.Second

// The states an AuthCheck can be in. The UI renders the WORD, never only a
// colour (Reindert is colourblind — see .claude/rules/conventions.md).
const (
	authStateOK      = "ok"      // authenticated and usable
	authStateError   = "error"   // configured but rejected/expired — needs action
	authStateMissing = "missing" // never configured at all
	authStateSkipped = "skipped" // switched off for this run (SLASH_*=off)
	// authStateUnavailable: the credentials themselves are still accepted (see
	// checkJiraToken's VerifyCredentials call), but the feature's own endpoint
	// is unreachable. Deliberately NOT authStateError: that word ("Afgekeurd")
	// would wrongly tell the reviewer their token is bad, when regenerating it
	// would not help — see the investigation note on checkJiraToken.
	authStateUnavailable = "unavailable"
)

// AuthCheck is one credential slash depends on.
type AuthCheck struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	State string `json:"state"`
	// Detail is a short, already-sanitised line from the tool's own output, or
	// a hand-written explanation. Never the raw multi-line output: `gh auth
	// status` prints a (masked) token line, and there is no reason to move any
	// of that into a browser.
	Detail string `json:"detail,omitempty"`
	// FixCommand is what the reviewer types in their own terminal to repair
	// this check, when the fix is a CLI login rather than a form field.
	FixCommand string `json:"fixCommand,omitempty"`
	// FixURL is where the credential comes from, when it is a token you fetch
	// from a website (the Atlassian API-token page).
	FixURL string `json:"fixUrl,omitempty"`
	// Editable marks a check the settings page can actually repair in-place
	// (the Jira API token trio), as opposed to one that needs a terminal.
	Editable bool `json:"editable,omitempty"`
	// Action names a repair the app can perform itself, for the settings page
	// to render a button for. Currently only "whisperModel" (download the
	// speech model). A machine-readable field rather than the page matching on
	// Detail text: that text is Dutch prose meant for a human, and translating
	// or rewording it must never silently remove a button.
	Action string `json:"action,omitempty"`
}

// AuthStatus is the whole answer of GET /api/auth/status.
type AuthStatus struct {
	CheckedAt time.Time   `json:"checkedAt"`
	OK        bool        `json:"ok"` // every check is ok or skipped
	Checks    []AuthCheck `json:"checks"`
	// Jira mirrors the currently configured notification-feed credentials so
	// the settings page can prefill its form. The TOKEN IS NEVER RETURNED —
	// only whether one is set and its last few characters, enough to tell two
	// tokens apart without handing the secret to every page that asks.
	Jira JiraCredsView `json:"jira"`
}

// JiraCredsView is the non-secret view of SLASH_JIRA_EMAIL/TOKEN/SITE.
type JiraCredsView struct {
	Email       string `json:"email"`
	Site        string `json:"site"`
	TokenSet    bool   `json:"tokenSet"`
	TokenMasked string `json:"tokenMasked,omitempty"`
	FromEnvOnly bool   `json:"fromEnvOnly,omitempty"`
}

var (
	authStatusMu     sync.Mutex
	authStatusCache  *AuthStatus
	authStatusCached time.Time
)

// jiraTokenPageURL is where an Atlassian API token comes from. Shown as a real
// link on the settings page and in the popup, because "waar haal ik dit
// vandaan" was the reviewer's own question.
const jiraTokenPageURL = "https://id.atlassian.com/manage-profile/security/api-tokens"

// checkAuthStatus runs every check and returns the fresh result. Cached by
// handleAuthStatus; force bypasses that cache.
func (m *TaskManager) checkAuthStatus(ctx context.Context) AuthStatus {
	st := AuthStatus{CheckedAt: time.Now()}
	st.Checks = append(st.Checks, checkGitHubAuth(ctx), checkJiraCLIAuth(ctx), m.checkJiraToken(ctx), m.checkWhisper())
	st.Jira = jiraCredsView()
	st.OK = true
	for _, c := range st.Checks {
		if c.State == authStateError || c.State == authStateMissing || c.State == authStateUnavailable {
			st.OK = false
		}
	}
	return st
}

// checkGitHubAuth runs `gh auth status`. Exit code is the verdict; the output
// only supplies a one-line detail.
func checkGitHubAuth(ctx context.Context) AuthCheck {
	c := AuthCheck{ID: "github", Label: "GitHub CLI (gh)", FixCommand: "gh auth login"}
	if os.Getenv("SLASH_GITHUB") == "off" {
		c.State = authStateSkipped
		c.Detail = "SLASH_GITHUB=off — GitHub wordt niet benaderd"
		return c
	}
	out, err := runAuthCommand(ctx, "gh", "auth", "status")
	if err != nil {
		c.State = authStateError
		c.Detail = firstMeaningfulLine(out, err.Error())
		return c
	}
	c.State = authStateOK
	c.Detail = firstMeaningfulLine(out, "")
	return c
}

// checkJiraCLIAuth runs `acli jira auth status` — the credential the pr_status
// tracker's Jira lookup uses. An expired OAuth session exits non-zero with
// "unauthorized: use 'acli jira auth login' to authenticate".
func checkJiraCLIAuth(ctx context.Context) AuthCheck {
	c := AuthCheck{ID: "jiraCli", Label: "Jira CLI (acli)", FixCommand: "acli jira auth login"}
	if os.Getenv("SLASH_JIRA") == "off" {
		c.State = authStateSkipped
		c.Detail = "SLASH_JIRA=off — Jira wordt niet benaderd"
		return c
	}
	out, err := runAuthCommand(ctx, "acli", "jira", "auth", "status")
	if err != nil {
		c.State = authStateError
		c.Detail = firstMeaningfulLine(out, err.Error())
		return c
	}
	if looksUnauthorized(out) {
		c.State = authStateError
		c.Detail = firstMeaningfulLine(out, "unauthorized")
		return c
	}
	c.State = authStateOK
	c.Detail = firstMeaningfulLine(out, "")
	return c
}

// checkJiraToken reports on the Atlassian API token behind the notification
// feed. Configured is not enough — an expired/revoked token looks identical
// until it is used — so a configured token is verified in TWO separate steps:
//
//  1. m.jira.VerifyCredentials, against the stable, documented
//     `/rest/api/2/myself` endpoint — this alone answers "is the token itself
//     still accepted".
//  2. only if that passes, one real, minimal call to the feed itself
//     (m.jira.Notifications), which uses an undocumented Atlassian gateway
//     endpoint (see the big comment at the top of notifications.go).
//
// Splitting these matters: investigated live (2026-09-05) against the real
// site with a real, valid token — `/rest/api/2/myself` returned 200, while
// EVERY path tried under `/gateway/api/notification-log/...` (several plausible
// API-version/sub-path variants) returned the exact same generic gateway 404 as
// a deliberately made-up path (`/gateway/api/totally-bogus-xyz123`), meaning
// that whole undocumented service looks to have been withdrawn by Atlassian —
// independent of the token. Reporting that as authStateError ("Afgekeurd")
// would tell the reviewer their token is bad and send them off to regenerate it
// for nothing; authStateUnavailable says the honest thing instead: token is
// fine, the (unofficial) feed just isn't reachable right now.
func (m *TaskManager) checkJiraToken(ctx context.Context) AuthCheck {
	c := AuthCheck{
		ID:       "jiraToken",
		Label:    "Jira API-token (notificaties)",
		FixURL:   jiraTokenPageURL,
		Editable: true,
	}
	if os.Getenv("SLASH_JIRA") == "off" {
		c.State = authStateSkipped
		c.Detail = "SLASH_JIRA=off — de notificatiefeed wordt niet opgehaald"
		return c
	}
	email, token, _ := jiraCredsFromEnv()
	if email == "" || token == "" {
		c.State = authStateMissing
		c.Detail = "Nog geen e-mailadres en API-token ingesteld — de Jira-notificatiefeed blijft leeg"
		return c
	}
	if m == nil || m.jira == nil {
		c.State = authStateOK
		c.Detail = "Ingesteld"
		return c
	}
	ctx, cancel := context.WithTimeout(ctx, authCheckTimeout)
	defer cancel()
	if err := m.jira.VerifyCredentials(ctx); err != nil {
		c.State = authStateError
		c.Detail = firstMeaningfulLine(err.Error(), "e-mailadres of token is niet (meer) geldig")
		return c
	}
	if _, err := m.jira.Notifications(ctx, 1); err != nil {
		c.State = authStateUnavailable
		c.Detail = "Token is geldig, maar de (niet-officiële) notificatiefeed van Atlassian zelf is niet bereikbaar (" +
			firstMeaningfulLine(err.Error(), "onbekende fout") +
			") — dit interne endpoint lijkt gewijzigd of verwijderd, opnieuw inloggen lost dit niet op"
		return c
	}
	c.State = authStateOK
	c.Detail = "Token werkt"
	return c
}

// checkWhisper reports whether local speech-to-text is usable: the whisper-cli
// binary plus the model file it needs (see whisper.go). Two separate pieces
// with two different fixes, so the Detail always says WHICH one is missing —
// "niet ingesteld" without saying what to install would be useless.
//
// It NEVER reports authStateError, only authStateMissing. brokenChecks()
// (src/authStatus.mjs) filters on exactly "error" to decide whether to throw up
// the global, keyboard-owning dialog, and dictation is an optional extra: a
// reviewer who has never installed whisper must not be nagged by a modal on
// every page load. "Niet ingesteld" in the settings list is the right volume
// for this.
//
// Unlike its three neighbours this check shells out to nothing — it is two
// stat() calls and a PATH lookup — so it needs no context and no timeout.
func (m *TaskManager) checkWhisper() AuthCheck {
	c := AuthCheck{ID: "whisper", Label: "Spraak naar tekst (whisper.cpp)"}
	appDir := ""
	if m != nil {
		appDir = m.appDataDirOrDefault()
	}
	model := whisperModelPath(appDir)
	if whisperBinPath() == "" {
		c.State = authStateMissing
		c.Detail = "whisper-cli is niet gevonden — zonder dat kan F5 (inspreken) niets uitschrijven"
		c.FixCommand = "brew install whisper.cpp"
		return c
	}
	if !fileExistsNonEmpty(model) {
		c.State = authStateMissing
		c.Detail = "whisper-cli is er, maar het taalmodel ontbreekt nog (" + model + ")"
		// The one piece slash can fetch itself — the settings page turns this
		// into its "Model downloaden" button.
		c.Action = "whisperModel"
		return c
	}
	c.State = authStateOK
	c.Detail = "Klaar voor gebruik — druk op F5 om in te spreken, nogmaals om te stoppen"
	return c
}

// runAuthCommand runs one status command and returns its combined output. A
// missing binary is an error like any other rejection — it means the same
// thing for the reviewer: this credential is not usable right now.
func runAuthCommand(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, authCheckTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return string(out), err
}

// looksUnauthorized catches a CLI that reports an expired session on stdout
// while still exiting 0 (acli has done both across versions).
func looksUnauthorized(out string) bool {
	low := strings.ToLower(out)
	return strings.Contains(low, "unauthorized") ||
		strings.Contains(low, "not authenticated") ||
		strings.Contains(low, "not logged in")
}

// firstMeaningfulLine reduces a tool's output to one short line for display:
// the first non-empty line that is not a bare hostname header, trimmed of the
// ✓/✗/- glyphs the CLIs decorate with, capped so a stray wall of text cannot
// take over the popup. fallback is used when nothing usable is left.
func firstMeaningfulLine(out, fallback string) string {
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		line = strings.TrimLeft(line, "✓✗×- \t")
		line = strings.TrimSpace(line)
		if line == "" || !strings.ContainsAny(line, " :") {
			continue // "github.com" and friends: a header, not a message
		}
		if len(line) > 160 {
			line = line[:157] + "…"
		}
		return line
	}
	return strings.TrimSpace(fallback)
}

// jiraCredsFromEnv reads the notification-feed credentials the same way
// modules/jira does — from the process environment, filled at startup from the
// gitignored .env (env.go).
func jiraCredsFromEnv() (email, token, site string) {
	return strings.TrimSpace(os.Getenv("SLASH_JIRA_EMAIL")),
		strings.TrimSpace(os.Getenv("SLASH_JIRA_TOKEN")),
		strings.TrimSpace(os.Getenv("SLASH_JIRA_SITE"))
}

// jiraCredsView builds the browser-safe view of those credentials. Site falls
// back to jira.DefaultSite when unset, so the settings page's form shows the
// domain that will actually be used (modules/jira's own notifyConfig applies
// the exact same fallback) instead of only a placeholder hint the reviewer
// might think they still need to type themselves.
func jiraCredsView() JiraCredsView {
	email, token, site := jiraCredsFromEnv()
	if site == "" {
		site = jira.DefaultSite
	}
	v := JiraCredsView{Email: email, Site: site, TokenSet: token != ""}
	if v.TokenSet {
		v.TokenMasked = maskSecret(token)
	}
	return v
}

// maskSecret keeps only the last 4 characters, so the reviewer can tell which
// token is stored without the value itself ever reaching the browser.
func maskSecret(s string) string {
	if len(s) <= 4 {
		return "••••"
	}
	return "••••" + s[len(s)-4:]
}

// handleAuthStatus serves GET /api/auth/status (read-only, see the write
// boundary note at the top of this file). ?refresh=1 forces a fresh run of the
// checks — that is the "Opnieuw controleren" button.
func (s *server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	force := r.URL.Query().Get("refresh") == "1"

	authStatusMu.Lock()
	if !force && authStatusCache != nil && time.Since(authStatusCached) < authStatusTTL {
		cached := *authStatusCache
		authStatusMu.Unlock()
		writeJSON(w, http.StatusOK, cached)
		return
	}
	authStatusMu.Unlock()

	var m *TaskManager
	if s.tasks != nil {
		m = s.tasks.manager
	}
	// Deliberately NOT r.Context(): this result is cached for authStatusTTL and
	// shared across every tab/page load, not just the request that happened to
	// trigger it. A reviewer refreshing the page while this request is still
	// in flight makes the browser drop that old connection, which cancels
	// r.Context() — and since checkJiraCLIAuth/checkJiraToken derive their own
	// timeout straight from the passed-in ctx, that killed the `acli` subprocess
	// and aborted the Jira HTTP call mid-check ("signal: killed" /
	// "context canceled"), and the resulting false failure then got cached and
	// served to the freshly reloaded page for up to a minute. Each check still
	// has its own bounded authCheckTimeout, so this cannot hang forever.
	st := m.checkAuthStatus(context.Background())

	authStatusMu.Lock()
	// Defense in depth: never let a result poisoned by a canceled context (a
	// disconnected client, here or from a future regression) sit in the cache
	// for other requests — serve it once, but let the next poll try again.
	if !hasCanceledCheck(st) {
		authStatusCache = &st
		authStatusCached = time.Now()
	}
	authStatusMu.Unlock()

	writeJSON(w, http.StatusOK, st)
}

// hasCanceledCheck reports whether any check's detail looks like it failed
// because its context was canceled mid-flight, rather than a genuine
// rejection — see the write-up in handleAuthStatus above.
func hasCanceledCheck(st AuthStatus) bool {
	for _, c := range st.Checks {
		if strings.Contains(c.Detail, context.Canceled.Error()) || strings.Contains(c.Detail, "signal: killed") {
			return true
		}
	}
	return false
}

// invalidateAuthStatus drops the cache, so the very next poll re-runs the
// checks. Called right after the Jira credentials are written, so the settings
// page never shows a stale "missing" for a token that was just saved.
func invalidateAuthStatus() {
	authStatusMu.Lock()
	authStatusCache = nil
	authStatusMu.Unlock()
}
