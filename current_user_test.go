package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/reindert-vetter/tembed"

	"slash/modules/github"
)

// TestCurrentUserCachesLookup proves the authenticated user is fetched at most
// once per process: the frontend asks /api/me on every page load, and a comment
// render must never cost a `gh api user` call per request.
func TestCurrentUserCachesLookup(t *testing.T) {
	gh := &github.Fake{}
	gh.SetCurrentUser(github.Collaborator{Login: "reindert-vetter", AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4"})

	m := NewTaskManager(tembed.New(tembed.NewMemoryStore()), gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	for i := 0; i < 3; i++ {
		me, err := m.CurrentUser(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if me.Login != "reindert-vetter" || me.AvatarURL == "" {
			t.Fatalf("CurrentUser = %+v, want the seeded login + avatar", me)
		}
	}
	if got := gh.CurrentUserCalls(); got != 1 {
		t.Fatalf("CurrentUserCalls = %d, want 1 (cached for the process lifetime)", got)
	}
}

// TestHandleMe covers both answers of the read-only endpoint: the real identity
// when gh knows one, and {ok:false} — never a hard error — when it does not
// (offline / SLASH_GITHUB=off), which makes the frontend fall back to whatever
// the comment itself carries.
func TestHandleMe(t *testing.T) {
	for _, tc := range []struct {
		name      string
		seed      github.Collaborator
		wantOK    bool
		wantLogin string
	}{
		{name: "known user", seed: github.Collaborator{Login: "reindert-vetter", AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4"}, wantOK: true, wantLogin: "reindert-vetter"},
		{name: "nothing known", seed: github.Collaborator{}, wantOK: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gh := &github.Fake{}
			gh.SetCurrentUser(tc.seed)
			m := NewTaskManager(tembed.New(tembed.NewMemoryStore()), gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
			s := &server{tasks: &tasks{manager: m}}

			rec := httptest.NewRecorder()
			s.handleMe(rec, httptest.NewRequest(http.MethodGet, "/api/me", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			var got struct {
				OK        bool   `json:"ok"`
				Login     string `json:"login"`
				AvatarURL string `json:"avatarUrl"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.OK != tc.wantOK {
				t.Fatalf("ok = %v, want %v (body %s)", got.OK, tc.wantOK, rec.Body.String())
			}
			if got.Login != tc.wantLogin {
				t.Fatalf("login = %q, want %q", got.Login, tc.wantLogin)
			}
			if tc.wantOK && got.AvatarURL != tc.seed.AvatarURL {
				t.Fatalf("avatarUrl = %q, want %q", got.AvatarURL, tc.seed.AvatarURL)
			}
		})
	}
}
