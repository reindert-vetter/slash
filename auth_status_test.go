package main

import (
	"context"
	"fmt"
	"testing"

	"slash/modules/jira"
)

// TestCheckJiraTokenDistinguishesRejectedTokenFromUnreachableFeed pins the fix
// for a real, investigated bug report: the settings page showed "Afgekeurd"
// (rejected) for the Jira API token even though the token itself was still
// valid — verified live against the real Atlassian site
// (GET /rest/api/2/myself returned 200) while the undocumented notification
// feed gateway (`/gateway/api/notification-log/...`) returned the exact same
// generic 404 as a deliberately made-up path, meaning that service looks to
// have been withdrawn by Atlassian, independent of the token. checkJiraToken
// must report those two situations differently: a real credential rejection
// stays authStateError, but a fine token whose feed endpoint is merely
// unreachable must become authStateUnavailable — never authStateError, which
// would send the reviewer off to needlessly regenerate a working token.
func TestCheckJiraTokenDistinguishesRejectedTokenFromUnreachableFeed(t *testing.T) {
	t.Setenv("SLASH_JIRA_EMAIL", "reviewer@example.com")
	t.Setenv("SLASH_JIRA_TOKEN", "some-token")
	t.Setenv("SLASH_JIRA_SITE", "example.atlassian.net")

	t.Run("credentials rejected", func(t *testing.T) {
		fake := &jira.Fake{VerifyErr: fmt.Errorf("jira: verify credentials: http 401")}
		m := &TaskManager{jira: fake}
		c := m.checkJiraToken(context.Background())
		if c.State != authStateError {
			t.Fatalf("state = %q, want %q", c.State, authStateError)
		}
	})

	t.Run("credentials fine but feed endpoint unreachable", func(t *testing.T) {
		// jira.Fake has no error hook for Notifications (it always succeeds),
		// so this branch is driven via a small local double instead — one
		// whose VerifyCredentials passes but whose Notifications call fails,
		// exactly like the real Module against a withdrawn feed endpoint.
		m := &TaskManager{jira: unreachableFeedJira{}}
		c := m.checkJiraToken(context.Background())
		if c.State != authStateUnavailable {
			t.Fatalf("state = %q, want %q", c.State, authStateUnavailable)
		}
	})

	t.Run("everything works", func(t *testing.T) {
		fake := &jira.Fake{}
		m := &TaskManager{jira: fake}
		c := m.checkJiraToken(context.Background())
		if c.State != authStateOK {
			t.Fatalf("state = %q, want %q", c.State, authStateOK)
		}
	})
}

// unreachableFeedJira is a jira.Client whose credentials verify fine but whose
// feed call always errors — jira.Fake has no error hook for Notifications, so
// this small local double drives that specific branch.
type unreachableFeedJira struct{}

func (unreachableFeedJira) Issue(context.Context, string) (jira.Issue, error) {
	return jira.Issue{}, nil
}

func (unreachableFeedJira) Notifications(context.Context, int) ([]jira.Notification, error) {
	return nil, fmt.Errorf("jira: notification feed: http 404")
}

func (unreachableFeedJira) Search(context.Context, string, int) ([]jira.Issue, error) {
	return nil, nil
}

func (unreachableFeedJira) VerifyCredentials(context.Context) error { return nil }

// TestJiraCredsViewFallsBackToDefaultSite pins the fix for the settings page's
// domain field showing only a placeholder hint instead of the real default: a
// fresh install with no SLASH_JIRA_SITE configured must still report the
// domain jira.Notifications actually falls back to at runtime.
func TestJiraCredsViewFallsBackToDefaultSite(t *testing.T) {
	t.Setenv("SLASH_JIRA_EMAIL", "reviewer@example.com")
	t.Setenv("SLASH_JIRA_TOKEN", "some-token")
	t.Setenv("SLASH_JIRA_SITE", "")

	v := jiraCredsView()
	if v.Site != jira.DefaultSite {
		t.Fatalf("Site = %q, want default %q", v.Site, jira.DefaultSite)
	}
}
