package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/inbox"
	"slash/modules/jira"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/testcovers"
)

// testInbox opens a throwaway inbox read-model for the manager under test.
func testInbox(t *testing.T) *inbox.Module {
	t.Helper()
	ib, err := inbox.Open(filepath.Join(t.TempDir(), "inbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ib.Close() })
	return ib
}

// testRelations opens a throwaway relations read-model for the manager.
func testRelations(t *testing.T) *relations.Module {
	t.Helper()
	rel, err := relations.Open(filepath.Join(t.TempDir(), "relations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rel.Close() })
	return rel
}

// testPRMeta opens a throwaway prmeta read-model for the manager.
func testPRMeta(t *testing.T) *prmeta.Module {
	t.Helper()
	pm, err := prmeta.Open(filepath.Join(t.TempDir(), "prmeta.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pm.Close() })
	return pm
}

// testTestCovers opens a throwaway testcovers read-model for the manager.
func testTestCovers(t *testing.T) *testcovers.Module {
	t.Helper()
	tc, err := testcovers.Open(filepath.Join(t.TempDir(), "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tc.Close() })
	return tc
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func newTestManager(t *testing.T) (*TaskManager, *github.Fake, *comments.Module) {
	t.Helper()
	// fetchPRStatuses (pr_status stage 3) shells to gh directly (statusesFor,
	// not the injected github.Client fake) — keep every test built on this
	// helper offline.
	t.Setenv("SLASH_GITHUB", "off")
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.interval = 3 * time.Millisecond // fast poll for the test
	m.idle = 3 * time.Millisecond     // idle cadence too, so tests never wait 10m
	return m, gh, cs
}

func TestTaskCodeCommentFlow(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "This branch looks unreachable.",
	})
	if err != nil {
		t.Fatal(err)
	}

	// The comment was posted to GitHub and stored by the comments module.
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}
	list, _ := cs.List(ctx, "", 42)
	if len(list) != 1 || list[0].ID != runID || list[0].Status != "open" {
		t.Fatalf("comments = %+v", list)
	}

	// A UI reaction hooks onto the comment (stored + mirrored to GitHub).
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Body: "please clarify"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 2 }) // mirrored reply
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].ReactionCount == 1
	})

	// A GitHub reaction arrives via the poller. IDs deliberately far above the
	// fake's own post/mirror counter (1 for the root, 2 for the mirrored
	// reply above) — real GitHub comment ids are globally unique, so a
	// genuinely external reply never collides with one this workflow itself
	// posted; using low, colliding numbers here would look like this
	// workflow's own echo-of-self guard (see the reply-Signal loop in
	// workflows.go) incorrectly swallowing a real external reply.
	gh.EnqueueReply(github.Reply{ID: 501, Author: "colleague", Body: "agreed"})
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].ReactionCount == 2
	})

	// A resolving reaction (Done, no "/resolve" text) resolves the comment — the
	// Done flag alone must do it. The Execution deliberately stays alive (it can
	// be unresolved again, see TestTaskCodeCommentUnresolveReopensThread).
	gh.EnqueueReply(github.Reply{ID: 502, Author: "colleague", Body: "looks fine now", Done: true})
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].Status == "resolved"
	})
	if s, _ := m.engine.Status(runID); s != tembed.StatusWaiting {
		t.Fatalf("status = %q, want waiting (a resolve no longer ends the thread)", s)
	}

	l, _ := cs.List(ctx, "", 42)
	if l[0].Status != "resolved" {
		t.Fatalf("status = %q, want resolved", l[0].Status)
	}
	if l[0].ReactionCount != 3 {
		t.Fatalf("reactionCount = %d, want 3", l[0].ReactionCount)
	}
	if len(l[0].Reactions) != 3 {
		t.Fatalf("reactions = %d, want 3", len(l[0].Reactions))
	}
}

// The reply poller a StartCodeComment launches must survive its caller: the
// real caller is handleTaskCodeComment, whose request context is cancelled the
// moment the response is written. Regression test for the poller being started
// on that request context — it then exited at its first tick, so a GitHub
// reply to an app-placed comment was never imported until a server restart's
// ResumePolling happened to pick the thread up again. The poller must run on
// the server-lifetime context (SetRuntime) instead.
func TestStartCodeCommentPollerSurvivesRequestContext(t *testing.T) {
	m, gh, cs := newTestManager(t)
	// The server-lifetime context, as newTasks wires it.
	baseCtx, baseCancel := context.WithCancel(context.Background())
	defer baseCancel()
	m.SetRuntime(baseCtx, true)

	// The "HTTP request": cancelled immediately after StartCodeComment returns,
	// exactly like a real handler's r.Context().
	reqCtx, reqCancel := context.WithCancel(context.Background())
	runID, err := m.StartCodeComment(reqCtx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "poller lifetime check",
	})
	if err != nil {
		t.Fatal(err)
	}
	reqCancel()

	gh.EnqueueReply(github.Reply{ID: 601, Author: "colleague", Body: "still here"})
	waitFor(t, func() bool {
		l, _ := cs.List(baseCtx, "", 42)
		return len(l) == 1 && l[0].ReactionCount == 1
	})
	_ = runID
}

// A normal (non-local, non-imported) comment gets its GitHub-posted comment id
// persisted into the read model (comments.Comment.GithubID) once the post
// completes — the frontend uses this to build a "view on GitHub" deep link
// (see focusedCommentGithubId in RelatedPanel.mjs).
func TestTaskCodeCommentPersistsGithubID(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "This branch looks unreachable.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}
	list, _ := cs.List(ctx, "", 42)
	if len(list) != 1 || list[0].ID != runID || list[0].GithubID == 0 {
		t.Fatalf("comments = %+v, want a non-zero githubId", list)
	}
}

// A local thread (a private note or an "ai" finding) touches GitHub only once
// the reviewer publishes it along with a reply — and from then on every next
// reply mirrors on its own, without asking again.
func TestPublishLocalThreadWithReply(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "AI check",
		Body: "Unchecked array access.", Source: "ai", Local: true, RowStart: -1, RowEnd: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 0 {
		t.Fatalf("github posted %d for a local comment, want 0", gh.PostedCount())
	}

	// Publish "reply": only the reviewer's own answer reaches GitHub, as the
	// thread's new root — the finding's own wording stays private.
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-1", Source: "ui", Author: "reindert", Body: "Fixed in the next commit.", Publish: "reply",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 1 })
	if got := gh.PostedBodies(); got[0] != "Fixed in the next commit." {
		t.Fatalf("posted %q, want only the reply body", got)
	}
	// The read model now says "this is a GitHub chat" (github_id != 0) — what
	// the UI reads to stop offering the publish choice.
	var rootGithubID int64
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		rootGithubID = l[0].GithubID
		return rootGithubID != 0
	})

	// A following reply needs no publish flag at all: the ordinary mirror path
	// now has a root to reply to.
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-2", Source: "ui", Author: "reindert", Body: "Done.",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 2 })
	if got := gh.PostedBodies(); got[1] != "Done." {
		t.Fatalf("posted %q, want the second reply mirrored", got)
	}

	// Editing the local root must NOT rewrite the GitHub comment that holds the
	// reply (see rootPublished in workflows.go).
	if err := m.Signal(runID, ReactionSignal{
		ID: runID, Source: "ui", Author: "reindert", Body: "Unchecked array access (line 12).", Action: "edit",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return l[0].Body == "Unchecked array access (line 12)."
	})
	if b, ok := gh.EditedReviews[rootGithubID]; ok {
		t.Fatalf("github review comment %d edited to %q, want untouched", rootGithubID, b)
	}
}

// Publishing the whole thread posts the finding itself as the root — quoted
// with an attribution marker so nobody reads it as the reviewer's own wording —
// and, on request, brings the earlier local replies along in order.
func TestPublishLocalThreadWithHistory(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "AI check",
		Body: "Unchecked array access.", Source: "ai", Local: true, RowStart: -1, RowEnd: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, body := range []string{"Looks intentional?", "No, it isn't."} {
		if err := m.Signal(runID, ReactionSignal{
			ID: fmt.Sprintf("ui-%d", i+1), Source: "ui", Author: "reindert", Body: body,
		}); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].ReactionCount == 2
	})
	if gh.PostedCount() != 0 {
		t.Fatalf("github posted %d while still local, want 0", gh.PostedCount())
	}

	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-3", Source: "ui", Author: "reindert", Body: "Publishing this.",
		Publish: "thread", PublishHistory: true,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 4 })
	want := []string{
		"> [AI-check] Unchecked array access.",
		"Looks intentional?",
		"No, it isn't.",
		"Publishing this.",
	}
	got := gh.PostedBodies()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("posted[%d] = %q, want %q (all: %q)", i, got[i], want[i], got)
		}
	}
}

// Without PublishHistory the earlier local replies stay local: only the root
// and the reply being sent reach GitHub.
func TestPublishLocalThreadKeepsHistoryLocal(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "Private note.", Local: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-1", Source: "ui", Author: "reindert", Body: "Only for me.",
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-2", Source: "ui", Author: "reindert", Body: "This one goes out.", Publish: "thread",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 2 })
	want := []string{"Private note.", "This one goes out."}
	got := gh.PostedBodies()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("posted[%d] = %q, want %q (all: %q)", i, got[i], want[i], got)
		}
	}
}

// The "publish" Action moves an EXISTING local conversation to GitHub without
// adding a message to it — the reviewer publishing from the comment menu
// instead of while sending a reply. It stores no reaction, and is a no-op once
// the thread is already on GitHub.
func TestPublishActionMovesThreadToGithub(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "AI check",
		Body: "Unchecked array access.", Source: "ai", Local: true, RowStart: -1, RowEnd: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-1", Source: "ui", Author: "reindert", Body: "Agreed, fixing.",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].ReactionCount == 1
	})

	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-2", Source: "ui", Author: "reindert", Action: "publish", PublishHistory: true,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 2 })
	want := []string{"> [AI-check] Unchecked array access.", "Agreed, fixing."}
	got := gh.PostedBodies()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("posted[%d] = %q, want %q (all: %q)", i, got[i], want[i], got)
		}
	}
	// No new reply was stored, and the thread now counts as a GitHub chat.
	l, _ := cs.List(ctx, "", 42)
	if l[0].ReactionCount != 1 {
		t.Fatalf("reactionCount = %d, want 1 (publish stores no reply)", l[0].ReactionCount)
	}
	if l[0].GithubID == 0 {
		t.Fatalf("comment = %+v, want a non-zero githubId", l[0])
	}

	// Publishing again changes nothing.
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-3", Source: "ui", Author: "reindert", Action: "publish", PublishHistory: true,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		hist, _ := m.engine.History(runID)
		n := 0
		for _, ev := range hist {
			if ev.Type == tembed.EventSignalReceived {
				n++
			}
		}
		return n == 3 // the second publish really was processed
	})
	if n := gh.PostedCount(); n != 2 {
		t.Fatalf("posted %d after a second publish, want 2", n)
	}
}

// Editing the root comment of a review-diff thread overwrites its own body in
// the read model and PATCHes the same GitHub review comment it was posted as.
func TestTaskCodeCommentEditRoot(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "This branch looks unreachable.",
	})
	if err != nil {
		t.Fatal(err)
	}
	list, _ := cs.List(ctx, "", 42)
	rootGithubID := list[0].GithubID
	if rootGithubID == 0 {
		t.Fatalf("comments = %+v, want a non-zero githubId", list)
	}

	if err := m.Signal(runID, ReactionSignal{
		ID: runID, Source: "ui", Author: "reindert", Body: "This branch is actually fine.", Action: "edit",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].Body == "This branch is actually fine."
	})
	waitFor(t, func() bool { return gh.EditedReviews[rootGithubID] == "This branch is actually fine." })
}

// Editing a reply overwrites its own body in the read model and PATCHes the
// GitHub comment that reply was mirrored to when it was first sent — not the
// thread's root comment.
func TestTaskCodeCommentEditReply(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "Check this.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Body: "please clarify"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && len(l[0].Reactions) == 1 && l[0].Reactions[0].GithubID != 0
	})
	list, _ := cs.List(ctx, "", 42)
	rootGithubID := list[0].GithubID
	replyGithubID := list[0].Reactions[0].GithubID
	if replyGithubID == rootGithubID {
		t.Fatalf("reply githubId %d must differ from root %d", replyGithubID, rootGithubID)
	}

	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-1", Source: "ui", Author: "reindert", Body: "please clarify the edge case", Action: "edit",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && len(l[0].Reactions) == 1 && l[0].Reactions[0].Body == "please clarify the edge case"
	})
	// The root comment's own body/GitHub comment were left untouched.
	list, _ = cs.List(ctx, "", 42)
	if list[0].Body != "Check this." {
		t.Fatalf("root body = %q, want unchanged", list[0].Body)
	}
	if _, edited := gh.EditedReviews[rootGithubID]; edited {
		t.Fatalf("root github comment %d must not have been edited", rootGithubID)
	}
	waitFor(t, func() bool { return gh.EditedReviews[replyGithubID] == "please clarify the edge case" })
}

// A UI reply that got mirrored to GitHub must not come back as a SECOND
// reaction once the per-thread poller (simulated here directly via a Signal,
// same shape poll() sends) fetches it back from the GitHub thread — it's an
// echo of the reply this workflow itself just posted, not a new external one.
// Regression for the "mijn comment meerdere keren terugkomen" bug.
func TestTaskCodeCommentGithubEchoOfOwnReplyIsIgnored(t *testing.T) {
	m, _, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "Check this.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Body: "please clarify"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && len(l[0].Reactions) == 1 && l[0].Reactions[0].GithubID != 0
	})
	list, _ := cs.List(ctx, "", 42)
	mirroredGithubID := list[0].Reactions[0].GithubID

	// The per-thread poller fetches this same reply back from GitHub and
	// signals it under its own GitHub-derived id ("gh-<id>"), exactly like
	// poll() does (workflows.go).
	if err := m.Signal(runID, ReactionSignal{
		ID: fmt.Sprintf("gh-%d", mirroredGithubID), Source: "github", Author: "reindert", Body: "please clarify",
	}); err != nil {
		t.Fatal(err)
	}

	// Give the echo a moment to (not) land, then assert the reaction count
	// stayed at 1 — a second reaction never gets stored.
	time.Sleep(30 * time.Millisecond)
	list, _ = cs.List(ctx, "", 42)
	if len(list) != 1 || len(list[0].Reactions) != 1 {
		t.Fatalf("reactions = %+v, want exactly 1 (echo of own reply must be ignored)", list[0].Reactions)
	}

	// A genuinely new, unrelated GitHub reply still comes through normally.
	if err := m.Signal(runID, ReactionSignal{
		ID: "gh-999999", Source: "github", Author: "someone-else", Body: "actually a real reply",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && len(l[0].Reactions) == 2
	})
}

// Editing the root of a PR-wide (issue) thread PATCHes the mirrored GitHub
// issue comment, not a review comment.
func TestTaskCodeCommentEditPRWideRootUsesIssueEndpoint(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, Author: "reindert", Body: "Overall this looks fine.", Kind: "issue",
	})
	if err != nil {
		t.Fatal(err)
	}
	list, _ := cs.List(ctx, "", 42)
	rootGithubID := list[0].GithubID
	if rootGithubID == 0 {
		t.Fatalf("comments = %+v, want a non-zero githubId", list)
	}

	if err := m.Signal(runID, ReactionSignal{
		ID: runID, Source: "ui", Author: "reindert", Body: "Overall this looks great.", Action: "edit",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.EditedIssues[rootGithubID] == "Overall this looks great." })
	if len(gh.EditedReviews) != 0 {
		t.Fatalf("edited reviews = %+v, want none (PR-wide root mirrors as an issue comment)", gh.EditedReviews)
	}
}

// A UI resolve of a review-diff thread resolves the conversation on GitHub via
// ResolveReviewThread, flips the read-model status to resolved, and never posts
// the "/resolve" sentinel as a reply comment.
func TestTaskCodeCommentUIResolveResolvesGithubThread(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "Check this.",
	})
	if err != nil {
		t.Fatal(err)
	}
	// The initial comment posts one review comment (root id 1).
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}

	// A UI resolve: done, body is the "/resolve" sentinel.
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-r", Source: "ui", Author: "reindert", Body: "/resolve", Done: true,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].Status == "resolved"
	})

	// The GitHub conversation was resolved for the root comment id (1)...
	if gh.ResolvedThreadCount() != 1 || gh.LastResolvedThread() != 1 {
		t.Fatalf("resolved threads = %d (last %d), want 1 (1)", gh.ResolvedThreadCount(), gh.LastResolvedThread())
	}
	// ...and the "/resolve" sentinel was NOT posted as a reply.
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1 (no /resolve text)", gh.PostedCount())
	}
	l, _ := cs.List(ctx, "", 42)
	if len(l) != 1 || l[0].Status != "resolved" {
		t.Fatalf("comments = %+v, want one resolved", l)
	}
}

// An "unresolve" action reopens a resolved review-diff thread: the read-model
// goes back to "open", the conversation is unresolved on GitHub, a "/reopen"
// trace message is stored WITHOUT being posted to GitHub as text, and the
// thread accepts an ordinary reply again afterwards (the whole point: a resolve
// no longer ends the Execution).
func TestTaskCodeCommentUnresolveReopensThread(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "Check this.",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-r", Source: "ui", Author: "reindert", Body: resolveSentinel, Done: true,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].Status == "resolved"
	})

	// Reopen it.
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-u", Source: "ui", Author: "reindert", Action: "unresolve",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].Status == "open"
	})

	// The GitHub conversation was reopened for the same root comment id (1)...
	if gh.UnresolvedThreadCount() != 1 || gh.LastUnresolvedThread() != 1 {
		t.Fatalf("unresolved threads = %d (last %d), want 1 (1)", gh.UnresolvedThreadCount(), gh.LastUnresolvedThread())
	}
	// ...and neither sentinel was posted as a reply comment (still just the root).
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1 (no sentinel text)", gh.PostedCount())
	}
	// The reopen left a visible trace in the conversation.
	l, _ := cs.List(ctx, "", 42)
	if len(l) != 1 || len(l[0].Reactions) != 2 || l[0].Reactions[1].Body != reopenSentinel {
		t.Fatalf("reactions = %+v, want the /resolve trace plus a %q one", l[0].Reactions, reopenSentinel)
	}

	// And the thread is a normal, live conversation again.
	if err := m.Signal(runID, ReactionSignal{
		ID: "ui-2", Source: "ui", Author: "reindert", Body: "one more thing",
	}); err != nil {
		t.Fatalf("reply after unresolve: %v", err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && len(l[0].Reactions) == 3 && l[0].Status == "open"
	})
	// That reply — and only that one — mirrored to GitHub (Fake.Reply records
	// into the same Posted list as the root, so: root + this reply).
	if gh.PostedCount() != 2 {
		t.Fatalf("github posted %d, want 2 (root + the reply after reopening)", gh.PostedCount())
	}
}

// A group comment posts as a multi-line range on the RIGHT side.
func TestTaskCodeCommentGroupRange(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 14, Author: "reindert",
		Body: "Looks off.", Gran: "group", StartLine: 10, EndLine: 14, Side: "RIGHT",
	}); err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}
	if gh.LastStartLine() != 10 || gh.LastEndLine() != 14 || gh.LastSide() != "RIGHT" {
		t.Fatalf("range = %d..%d side=%s, want 10..14 RIGHT", gh.LastStartLine(), gh.LastEndLine(), gh.LastSide())
	}
}

// A call comment's GitHub-posted body is prefixed with the segment as a code
// span, but the stored (thread) body stays raw.
func TestTaskCodeCommentCallSegmentPrefix(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 7, Author: "reindert",
		Body: "Check the null case.", Gran: "call", StartLine: 7, EndLine: 7, Side: "RIGHT",
		Segment: "->billingAddress()",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}
	body := gh.LastPostedBody()
	want := "`->billingAddress()`\n\nCheck the null case."
	if body != want {
		t.Fatalf("posted body = %q, want %q", body, want)
	}
	list, _ := cs.List(ctx, "", 42)
	if len(list) != 1 || list[0].ID != runID || list[0].Body != "Check the null case." {
		t.Fatalf("stored comment body = %+v, want raw body untouched", list)
	}
}

// A removed line posts with side LEFT.
func TestTaskCodeCommentRemovedLineSide(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 5, Author: "reindert",
		Body: "This was removed.", Gran: "line", StartLine: 5, EndLine: 5, Side: "LEFT",
	}); err != nil {
		t.Fatal(err)
	}
	if gh.LastSide() != "LEFT" {
		t.Fatalf("side = %q, want LEFT", gh.LastSide())
	}
	if gh.LastStartLine() != 5 || gh.LastEndLine() != 5 {
		t.Fatalf("range = %d..%d, want 5..5", gh.LastStartLine(), gh.LastEndLine())
	}
}

// Backward compat: an input with only Line set (no StartLine/EndLine/Side)
// still posts single-line RIGHT on that line.
func TestTaskCodeCommentLineOnlyBackwardCompat(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "Old-style input.",
	}); err != nil {
		t.Fatal(err)
	}
	if gh.LastStartLine() != 10 || gh.LastEndLine() != 10 || gh.LastSide() != "RIGHT" {
		t.Fatalf("range = %d..%d side=%s, want 10..10 RIGHT", gh.LastStartLine(), gh.LastEndLine(), gh.LastSide())
	}
}

// A local ("alleen voor mijzelf") note is stored as a comment but never posted
// to GitHub: the workflow skips postGithubComment, so posted.RootID stays 0 and
// deleting it also makes no GitHub call.
func TestTaskCodeCommentLocalSkipsGitHub(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "note to self", Local: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Stored in the read-model, but nothing posted to GitHub.
	if gh.PostedCount() != 0 {
		t.Fatalf("github posted %d, want 0 for a local note", gh.PostedCount())
	}
	list, _ := cs.List(ctx, "", 42)
	if len(list) != 1 || list[0].ID != runID || list[0].Status != "open" {
		t.Fatalf("comments = %+v", list)
	}
	if list[0].GithubID != 0 {
		t.Fatalf("githubId = %d, want 0 for a local note (never posted)", list[0].GithubID)
	}

	// Deleting a local note removes it from the store without a GitHub delete
	// (RootID 0 → deleteGithubComment no-ops).
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Action: "delete"}); err != nil {
		t.Fatal(err)
	}
	if s, _ := m.engine.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %q, want completed", s)
	}
	if l, _ := cs.List(ctx, "", 42); len(l) != 0 {
		t.Fatalf("comments = %+v, want none after delete", l)
	}
	if gh.DeletedCount() != 0 {
		t.Fatalf("github deleted %d, want 0 for a local note", gh.DeletedCount())
	}
}

// Deleting a comment flips its status to "deleting" first (markCommentDeleting),
// then removes it from GitHub (best-effort) and from our own store, and
// completes the execution.
func TestTaskCodeCommentDelete(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert", Body: "please look at this",
	})
	if err != nil {
		t.Fatal(err)
	}

	// A reaction first, so the delete also has to cascade a real reaction row.
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Body: "ack"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].ReactionCount == 1
	})

	if err := m.Signal(runID, ReactionSignal{ID: "ui-2", Source: "ui", Author: "reindert", Action: "delete"}); err != nil {
		t.Fatal(err)
	}

	// The execution completes as part of the delete flow (SignalWorkflow drives
	// the workflow synchronously to its next block point).
	if s, _ := m.engine.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %q, want completed", s)
	}
	// The comment (and its cascaded reaction) is gone from the read-model.
	list, err := cs.List(ctx, "", 42)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("comments = %+v, want none after delete", list)
	}
	// GitHub's copy was removed too (best-effort call still happened).
	if gh.DeletedCount() != 1 {
		t.Fatalf("github deleted %d, want 1", gh.DeletedCount())
	}

	// The status must have flipped to "deleting" before the row itself was
	// removed — assert the two activities ran in that order in the history.
	hist, err := m.engine.History(runID)
	if err != nil {
		t.Fatal(err)
	}
	var markIdx, deleteIdx = -1, -1
	for i, ev := range hist {
		if ev.Type != tembed.EventActivityCompleted {
			continue
		}
		switch ev.Name {
		case "markCommentDeleting":
			markIdx = i
		case "deleteComment":
			deleteIdx = i
		}
	}
	if markIdx == -1 || deleteIdx == -1 || markIdx >= deleteIdx {
		t.Fatalf("expected markCommentDeleting (idx %d) before deleteComment (idx %d)", markIdx, deleteIdx)
	}
}

// A comment can be deleted before it ever receives a reaction.
func TestTaskCodeCommentDeleteWithoutReactions(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 43, File: "src/Order.php", Line: 3, Author: "reindert", Body: "typo",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Action: "delete"}); err != nil {
		t.Fatal(err)
	}

	if s, _ := m.engine.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %q, want completed", s)
	}
	list, _ := cs.List(ctx, "", 43)
	if len(list) != 0 {
		t.Fatalf("comments = %+v, want none after delete", list)
	}
	if gh.DeletedCount() != 1 {
		t.Fatalf("github deleted %d, want 1", gh.DeletedCount())
	}
}

// When the PR is merged/closed, the idle poller records it on the pr_status
// tracker and stops.
func TestPollStopsWhenPRMerged(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 7, File: "a.php", Line: 1, Author: "reindert", Body: "q",
	})
	if err != nil {
		t.Fatal(err)
	}

	prRunID, err := m.ensurePRStatus("", 7) // returns the tracker started at StartCodeComment
	if err != nil {
		t.Fatal(err)
	}
	// ensurePRStatus starts pr_status with StartWorkflowDeferLow: stage 1
	// (basics) runs synchronously, but generatePRSummary (stage 2,
	// PriorityLow) and the statuses after it drain in the BACKGROUND so a
	// startup ensure never blocks on the LLM summary — so the run is still
	// 'running' for a beat before it settles on the signal loop's WaitSignal.
	// Wait for that background advance instead of reading the status once (the
	// same deferral TestPRStatusThreeStages waits out with engine.Wait()).
	waitFor(t, func() bool {
		s, _ := m.engine.Status(prRunID)
		return s == tembed.StatusWaiting
	})

	// The PR merges — the idle poller must observe it, record it, and complete
	// the tracker.
	gh.SetPRState("merged")
	waitFor(t, func() bool {
		s, _ := m.engine.Status(prRunID)
		return s == tembed.StatusCompleted
	})

	// The code-comment execution itself is untouched (still open/waiting).
	if s, _ := m.engine.Status(runID); s != tembed.StatusWaiting {
		t.Fatalf("comment run = %q, want waiting", s)
	}
}

// An active reviewer (recent heartbeat) keeps the fast cadence and never checks
// the PR state, so a merged PR does not stop the poller.
func TestHeartbeatKeepsActive(t *testing.T) {
	m, gh, _ := newTestManager(t)
	m.interval = 20 * time.Millisecond // first tick fires after the setup below
	m.idle = time.Hour                 // if the poller ever went idle it would stall the test
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 8, File: "a.php", Line: 1, Author: "reindert", Body: "q",
	})
	if err != nil {
		t.Fatal(err)
	}
	prRunID, _ := m.ensurePRStatus("", 8)

	m.Heartbeat(runID) // reviewer is active → fast cadence, no PR-state check
	gh.SetPRState("merged")

	// A GitHub reply still flows (the fast poller runs)...
	gh.EnqueueReply(github.Reply{ID: 1, Author: "colleague", Body: "ok"})
	waitFor(t, func() bool {
		hist, _ := m.engine.History(runID)
		for _, ev := range hist {
			if ev.Type == tembed.EventSignalReceived && ev.Name == SignalReply {
				return true
			}
		}
		return false
	})
	// ...but the merged PR is ignored while active: the tracker stays waiting.
	if s, _ := m.engine.Status(prRunID); s != tembed.StatusWaiting {
		t.Fatalf("pr_status = %q, want waiting (active reviewer ignores PR state)", s)
	}
}

// A 404 fetching replies while the repo itself is unreachable (an
// expired/narrowed `gh` credential, say) must never delete the comment: the
// data still exists on GitHub, we just can't currently see it. The poller
// keeps running (so it picks the thread back up once access returns) and
// logs the outage once, not on every cycle.
func TestPollPausesOnRepoInaccessible404(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 51, File: "a.php", Line: 1, Author: "reindert", Body: "q",
	})
	if err != nil {
		t.Fatal(err)
	}

	gh.SetFetchRepliesErr(errors.New(`gh api GET repos/plug-and-pay/plug-and-pay/pulls/51/comments?per_page=100: exit status 1: gh: Not Found (HTTP 404)`))
	gh.SetRepoAccessible(false)

	// Give the poller several cycles (m.interval/idle are 3ms) to hit this
	// path repeatedly; nothing should ever get deleted.
	time.Sleep(30 * time.Millisecond)

	if s, _ := m.engine.Status(runID); s != tembed.StatusWaiting {
		t.Fatalf("status = %q, want waiting (comment untouched while repo is inaccessible)", s)
	}
	list, _ := cs.List(ctx, "", 51)
	if len(list) != 1 {
		t.Fatalf("comments = %+v, want the comment still present", list)
	}
}

// A 404 fetching replies while the repo IS reachable means the comment/thread
// itself was removed on GitHub — the poller reuses the existing delete flow
// to clean up its own record and stop.
func TestPollDeletesCommentOnGoneButRepoAccessible404(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 52, File: "a.php", Line: 1, Author: "reindert", Body: "q",
	})
	if err != nil {
		t.Fatal(err)
	}

	gh.SetFetchRepliesErr(errors.New(`gh api GET repos/plug-and-pay/plug-and-pay/pulls/52/comments?per_page=100: exit status 1: gh: Not Found (HTTP 404)`))
	// RepoAccessible defaults to true on a fresh Fake — the repo is reachable,
	// only this thread's comment is gone.

	waitFor(t, func() bool {
		s, _ := m.engine.Status(runID)
		return s == tembed.StatusCompleted
	})
	list, _ := cs.List(ctx, "", 52)
	if len(list) != 0 {
		t.Fatalf("comments = %+v, want none after the gone-comment cleanup", list)
	}
}

func TestPRInboxRefreshPopulatesReadModel(t *testing.T) {
	// Offline: the refreshInbox Activity reads the fixture instead of GitHub.
	t.Setenv("SLASH_GITHUB", "off")
	t.Setenv("SLASH_INBOX", "tests/fixtures/inbox.json")

	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ib := testInbox(t)
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, ib, testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, db, "", repoSlug)

	runID, err := engine.StartWorkflow(WorkflowPRInbox, PRInboxInput{Repo: repoSlug})
	if err != nil {
		t.Fatal(err)
	}
	// Before any refresh, the read-model is empty (no direct GitHub read exists).
	if snap, _ := ib.Get(context.Background(), repoSlug); snap != nil {
		t.Fatalf("read-model populated before any refresh: %+v", snap)
	}
	// A refresh signal drives the fetch+save Activity synchronously.
	if err := m.RefreshInbox(runID); err != nil {
		t.Fatal(err)
	}
	snap, err := ib.Get(context.Background(), repoSlug)
	if err != nil || snap == nil {
		t.Fatalf("read-model empty after refresh (err=%v)", err)
	}
	var sections []inboxSection
	if err := json.Unmarshal(snap.Sections, &sections); err != nil {
		t.Fatalf("sections json: %v", err)
	}
	found := false
	for _, s := range sections {
		for _, p := range s.PRs {
			if p.Number == 12903 {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("expected PR 12903 in the refreshed inbox, got %+v", sections)
	}
}

// TestPRInboxBadgeCountsOpenSlashComments proves the "💬 n" badge count comes
// from slash's own comments read-model (open, GITHUB-SOURCED comments only),
// NOT GitHub's raw PullRequest.comments.totalCount and NOT a local (source:
// ""/"ui") comment that was never posted to GitHub — e.g. a private "Alleen
// voor mijzelf" note or the auto-created Claude-chat anchor comment (see
// ensureClaudeAnchorForNew in RelatedPanel.mjs) must not inflate a count meant
// to mirror the real GitHub comment count. Seeds 2 open github-sourced + 1
// resolved github-sourced + 1 deleting github-sourced + 1 open LOCAL comment
// on a fixture PR and asserts the enriched inbox row reports 2 (the local one
// excluded despite being open).
func TestPRInboxBadgeCountsOpenSlashComments(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off")
	t.Setenv("SLASH_INBOX", "tests/fixtures/inbox.json")

	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })

	// PR 12903 is in the fixture. Seed 2 open + 1 resolved + 1 deleting, all
	// github-sourced, plus 1 open LOCAL (source: "ui") comment that must not
	// be counted.
	seed := func(id, status, source string) {
		if err := cs.Save(context.Background(), comments.Comment{
			ID: id, RunID: id, PR: 12903, File: "a.php", Line: 1,
			Author: "reviewer", Body: "b", Status: status, Source: source,
		}); err != nil {
			t.Fatal(err)
		}
	}
	seed("open-1", "open", "github")
	seed("open-2", "open", "github")
	seed("resolved-1", "resolved", "github")
	seed("deleting-1", "deleting", "github")
	seed("local-open-1", "open", "ui")

	ib := testInbox(t)
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, cs, ib, testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, db, "", repoSlug)

	runID, err := engine.StartWorkflow(WorkflowPRInbox, PRInboxInput{Repo: repoSlug})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.RefreshInbox(runID); err != nil {
		t.Fatal(err)
	}
	snap, err := ib.Get(context.Background(), repoSlug)
	if err != nil || snap == nil {
		t.Fatalf("read-model empty after refresh (err=%v)", err)
	}
	var sections []inboxSection
	if err := json.Unmarshal(snap.Sections, &sections); err != nil {
		t.Fatalf("sections json: %v", err)
	}
	got, found := -1, false
	for _, s := range sections {
		for _, p := range s.PRs {
			if p.Number == 12903 {
				got, found = p.Comments, true
			}
		}
	}
	if !found {
		t.Fatalf("PR 12903 not in refreshed inbox: %+v", sections)
	}
	if got != 2 {
		t.Fatalf("badge count = %d, want 2 (only the 2 open github-sourced comments; resolved/deleting/local excluded)", got)
	}
}

func TestTaskSurvivesRestart(t *testing.T) {
	store := tembed.NewMemoryStore()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	gh := &github.Fake{}

	ib := testInbox(t)
	e1 := tembed.New(store)
	NewTaskManager(e1, gh, cs, ib, testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	runID, err := e1.StartWorkflow(WorkflowTaskCodeComment, CodeCommentInput{PR: 1, File: "a.php", Line: 1, Body: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("posted %d, want 1", gh.PostedCount())
	}

	// Restart: a new engine over the same store must not re-post the comment.
	e2 := tembed.New(store)
	NewTaskManager(e2, gh, cs, ib, testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	if err := e2.Recover(); err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("after restart posted %d, want 1 (no re-post)", gh.PostedCount())
	}

	if err := e2.SignalWorkflow(runID, SignalReply, ReactionSignal{ID: "gh-9", Source: "github", Body: "done /resolve", Done: true}); err != nil {
		t.Fatal(err)
	}
	// The recovered run accepts the resolve and keeps waiting (a resolve no
	// longer ends the thread, so it can be unresolved later).
	if s, _ := e2.Status(runID); s != tembed.StatusWaiting {
		t.Fatalf("status = %s, want waiting", s)
	}
	if l, _ := cs.List(context.Background(), "", 1); len(l) != 1 || l[0].Status != "resolved" {
		t.Fatalf("comments = %+v, want one resolved", l)
	}
}

// TestPRStatusFetchesMeta asserts the pr_status tracker fetches the PR's
// metadata (title + URL) into the prmeta read-model at start (synchronously,
// inside EnsurePRStatus → StartWorkflow), which is what feeds the `/` menu.
func TestPRStatusFetchesMeta(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off") // fetchPRStatuses shells to gh directly (statusesFor); keep this test offline
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	gh.SetPRMeta(github.Meta{Title: "PS-123 fix the thing", URL: "https://github.com/x/y/pull/7"})
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.EnsurePRStatus("", 7); err != nil {
		t.Fatal(err)
	}
	meta, ok, err := pm.Get(context.Background(), "", 7)
	if err != nil || !ok {
		t.Fatalf("meta not stored (ok=%v err=%v)", ok, err)
	}
	if meta.Title != "PS-123 fix the thing" {
		t.Fatalf("title = %q, want %q", meta.Title, "PS-123 fix the thing")
	}
	if meta.URL == "" {
		t.Fatalf("url empty, want stored")
	}
}

// errJira is a jira.Client whose Issue call always fails, for exercising the
// "skipped" log path fetchPRBasics takes on a Jira hiccup.
type errJira struct{ err error }

func (e errJira) Issue(context.Context, string) (jira.Issue, error) { return jira.Issue{}, e.err }
func (e errJira) Notifications(context.Context, int) ([]jira.Notification, error) {
	return nil, nil
}

func (e errJira) Search(context.Context, string, int) ([]jira.Issue, error) { return nil, nil }

func (e errJira) IssuesByKey(context.Context, []string) ([]jira.Issue, error) { return nil, nil }

func (e errJira) IssueSprints(context.Context, string) ([]jira.Sprint, error) { return nil, nil }

func (e errJira) VerifyCredentials(context.Context) error { return nil }

func (e errJira) AddComment(context.Context, string, json.RawMessage) (string, error) {
	return "", e.err
}

func (e errJira) Users(context.Context, string, int) ([]jira.User, error) { return nil, nil }

func (e errJira) Transition(context.Context, string, string) error { return e.err }

// TestPRStatusJiraFailureLogsPR pins the fix for a Jira-issue-fetch failure
// (e.g. `acli` not logged in) that skipped silently in the terminal but never
// reached the review tree's own "Taken" block: pollProblems (home.mjs) filters
// GET /api/problems' logErrors by `e.pr === state.pr`, and the fetchPRBasics
// log line used to carry no `pr=<n>` fragment at all, so recordProblem's
// rePRField never found one and every such line stayed PR 0 forever — visible
// only in the repo-wide /pr-overview drawer, never on the PR it was actually
// about. This drives the real fetchPRBasics Activity (via EnsurePRStatus, the
// same path TestPRStatusFetchesMeta uses) with a PR title that resolves to a
// Jira key and a Jira client that always errors, and asserts the mirrored log
// line names this PR.
func TestPRStatusJiraFailureLogsPR(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off")
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	gh.SetPRMeta(github.Meta{Title: "STAT-1103 fix the thing", URL: "https://github.com/x/y/pull/7"})
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil,
		errJira{err: fmt.Errorf("acli jira workitem view STAT-1103: exit status 1")}, nil, "", "test/repo")

	var logs []string
	m.logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }

	if _, err := m.EnsurePRStatus("", 7); err != nil {
		t.Fatal(err)
	}

	var found string
	for _, l := range logs {
		if strings.Contains(l, "fetch jira") {
			found = l
			break
		}
	}
	if found == "" {
		t.Fatalf("no 'fetch jira' log line, got: %v", logs)
	}
	if !strings.Contains(found, "pr=7") {
		t.Fatalf("jira failure log line missing pr=7: %q", found)
	}
}

// TestPRStatusThreeStages asserts the pr_status tracker fills the prmeta
// read-model in its three stages — basics (incl. the linked Jira issue),
// Claude summary, review/CI statuses — all at start, before the tracker parks
// on its first state Signal.
func TestPRStatusThreeStages(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off") // fetchPRStatuses shells to gh directly (statusesFor); keep this test offline
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })

	gh := &github.Fake{}
	gh.SetPRMeta(github.Meta{
		Title: "INTEG-562 fix the thing", URL: "https://github.com/x/y/pull/7",
		Body: "does a thing", Author: "alice", Additions: 10, Deletions: 2, ChangedFiles: 1, HeadRef: "feature/x",
	})
	jr := &jira.Fake{}
	jr.SetIssue("INTEG-562", jira.Issue{
		Key: "INTEG-562", Title: "Jira title", Description: "Jira description",
		URL: "https://plugandpaybv.atlassian.net/browse/INTEG-562",
	})
	cl := claude.NewFake()
	cl.SetOutput(claude.ModelHaiku, "This PR fixes the thing.")

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, cl, jr, nil, "", "test/repo")

	if _, err := m.EnsurePRStatus("", 7); err != nil {
		t.Fatal(err)
	}
	// EnsurePRStatus starts pr_status with StartWorkflowDeferLow: basics (stage
	// 1) run synchronously, but generatePRSummary (stage 2, PriorityLow) and the
	// statuses that follow it drain in the background so a startup ensure never
	// blocks on the LLM summary. Wait for that background advance before asserting
	// the later stages (the Fake Haiku returns immediately, so this is quick).
	engine.Wait()

	meta, ok, err := pm.Get(context.Background(), "", 7)
	if err != nil || !ok {
		t.Fatalf("meta not stored (ok=%v err=%v)", ok, err)
	}
	// Stage 1: basics + Jira.
	if meta.Title != "INTEG-562 fix the thing" || meta.Body != "does a thing" || meta.Author != "alice" {
		t.Fatalf("basics = %+v", meta)
	}
	if meta.JiraKey != "INTEG-562" || meta.JiraTitle != "Jira title" || meta.JiraDesc != "Jira description" {
		t.Fatalf("jira fields = %+v", meta)
	}
	// Stage 2: Claude summary.
	if meta.Summary != "This PR fixes the thing." {
		t.Fatalf("summary = %q", meta.Summary)
	}
	// Stage 3: statuses. The Fake github/statusesFor path (no real gh) yields no
	// heavy status — assert it didn't error the tracker and stays zero.
	if meta.ChecksTotal != 0 || meta.ReviewDecision != "" {
		t.Fatalf("statuses = %+v, want zero (no gh in test)", meta)
	}
}

func TestCommentPath(t *testing.T) {
	cases := []struct {
		name string
		in   CodeCommentInput
		id   string
		want string
	}{
		{
			name: "call unit with segment",
			in:   CodeCommentInput{PR: 123, File: "app/Actions/Foo.php", Label: "Foo::bar", Gran: "call", RowStart: 7, RowEnd: 7, Seg: "r12-18"},
			id:   "abc",
			want: "/pr-123/app/Actions/Foo.php/Foo::bar/call-7-r12-18/comment-abc",
		},
		{
			name: "group unit",
			in:   CodeCommentInput{PR: 123, File: "app/Foo.php", Label: "Foo::bar", Gran: "group", RowStart: 5, RowEnd: 9},
			id:   "x",
			want: "/pr-123/app/Foo.php/Foo::bar/group-5-9/comment-x",
		},
		{
			name: "line unit",
			in:   CodeCommentInput{PR: 7, File: "a.php", Label: "A::b", Gran: "line", RowStart: 3, RowEnd: 3},
			id:   "y",
			want: "/pr-7/a.php/A::b/line-3/comment-y",
		},
		{
			name: "unknown anchor falls back to gran",
			in:   CodeCommentInput{PR: 9, File: "a.php", Label: "A::b", Gran: "group", RowStart: -1, RowEnd: -1},
			id:   "z",
			want: "/pr-9/a.php/A::b/group/comment-z",
		},
		{
			name: "spaces in label are sanitised, slash cannot be injected",
			in:   CodeCommentInput{PR: 1, File: "a.php", Label: "A::b c/d", Gran: "line", RowStart: 0, RowEnd: 0},
			id:   "w",
			want: "/pr-1/a.php/A::b-c-d/line-0/comment-w",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := commentPath(tc.in, tc.id); got != tc.want {
				t.Errorf("commentPath = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestRunsForPR asserts RunsForPR filters workflow runs by their input's PR
// number and excludes runs without one (pr_inbox), so the read-only "Taken"
// endpoint only ever shows runs that belong to the requested PR.
func TestRunsForPR(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off")
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.EnsurePRStatus("", 101); err != nil {
		t.Fatal(err)
	}
	if _, err := m.EnsurePRStatus("", 202); err != nil {
		t.Fatal(err)
	}
	m.EnsureInbox(context.Background()) // per-repo, no "pr" field — must not leak into either PR's list

	runs := m.RunsForPR(101)
	if len(runs) != 1 {
		t.Fatalf("RunsForPR(101) = %d runs, want 1 (%+v)", len(runs), runs)
	}
	if runs[0].Workflow != WorkflowPRStatus {
		t.Fatalf("workflow = %q, want %q", runs[0].Workflow, WorkflowPRStatus)
	}
	if runs[0].Status != tembed.StatusWaiting && runs[0].Status != tembed.StatusRunning {
		t.Fatalf("status = %q, want waiting/running", runs[0].Status)
	}

	runs202 := m.RunsForPR(202)
	if len(runs202) != 1 {
		t.Fatalf("RunsForPR(202) = %d runs, want 1", len(runs202))
	}

	if runs := m.RunsForPR(999); len(runs) != 0 {
		t.Fatalf("RunsForPR(999) = %d runs, want 0", len(runs))
	}
}

// TestSinceReviewFacts pins the deterministic half of the "sinds jouw laatste
// review" block: newest commit first (that's what a returning reviewer looks
// for), the list capped with an "en N meer" tail, and the count leading the
// heading. The touched files are deliberately absent from what the column
// renders and present only in the Haiku prompt — see sinceReviewPrompt.
func TestSinceReviewFacts(t *testing.T) {
	commits := []github.SinceCommit{
		{Headline: "oudste", Author: "alice"},
		{Headline: "middelste", Author: "bob"},
		{Headline: "nieuwste"},
	}
	got := sinceReviewFacts(commits)
	if !strings.Contains(got, "**3 nieuwe commits** sinds jouw laatste review:") {
		t.Errorf("missing commit heading in:\n%s", got)
	}
	iNew := strings.Index(got, "nieuwste")
	iOld := strings.Index(got, "oudste")
	if iNew < 0 || iOld < 0 || iNew > iOld {
		t.Errorf("newest commit should come first, got:\n%s", got)
	}
	if !strings.Contains(got, "- middelste (bob)") {
		t.Errorf("author not rendered, got:\n%s", got)
	}
	// The file list left the column entirely (reviewer: "het 211 bestanden
	// geraakt-blok mag weg") but still reaches the AI as context.
	if strings.Contains(got, "geraakt:") || strings.Contains(got, "a.php") {
		t.Errorf("file list should not be rendered any more, got:\n%s", got)
	}
	prompt := sinceReviewPrompt(got, []string{"a.php", "b.php"})
	if !strings.Contains(prompt, "**2 bestanden** geraakt:") || !strings.Contains(prompt, "- `a.php`") {
		t.Errorf("missing file list in the prompt:\n%s", prompt)
	}
	if !strings.HasPrefix(prompt, got) {
		t.Errorf("prompt should start with the rendered facts:\n%s", prompt)
	}
	if bare := sinceReviewPrompt(got, nil); bare != got {
		t.Errorf("no files means prompt == facts, got:\n%s", bare)
	}

	many := make([]github.SinceCommit, 0, 12)
	for i := 0; i < 12; i++ {
		many = append(many, github.SinceCommit{Headline: fmt.Sprintf("c%d", i)})
	}
	got = sinceReviewFacts(many)
	if !strings.Contains(got, "- en 4 meer") {
		t.Errorf("long commit list not capped, got:\n%s", got)
	}
	if strings.Contains(got, "1 nieuwe commits") {
		t.Errorf("plural leaked into a single-count heading:\n%s", got)
	}
	if one := sinceReviewFacts(commits[:1]); !strings.Contains(one, "**1 nieuwe commit** sinds") {
		t.Errorf("singular heading wrong: %s", one)
	}
}

// The review tree's "Sinds jouw laatste review" block is fed by pr_status
// stages 3+4, which used to run ONLY at Execution start while the tracker is
// reused for the PR's whole lifetime — so the block stayed empty/stale forever
// after, even though the PR overview's own live "nieuw sinds jouw review" line
// already said there was something new. This pins the refresh path end to end:
// the "state" signal reaches handleWorkflows' dispatcher (a missing case there
// is exactly how TestHandleWorkflowsPushSignal's bug went unnoticed), only its
// refreshSince half is accepted from the outside, and the branch really re-runs
// both stages.
func TestRefreshSinceSignalRerunsStagesThreeAndFour(t *testing.T) {
	m, _, _ := newTestManager(t)
	s := &server{tasks: &tasks{manager: m, engine: m.engine}}

	prRunID, err := m.ensurePRStatus("", 9)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		st, _ := m.engine.Status(prRunID)
		return st == tembed.StatusWaiting
	})
	before := activityCount(t, m, prRunID, "fetchPRStatuses")

	// A lifecycle state / ingest-refresh SHA is the server pollers' own
	// business and must not be accepted from the outside.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/workflows/"+prRunID+"/signals/state", strings.NewReader(`{"state":"merged"}`))
	s.handleWorkflows(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("lifecycle state from the UI: status = %d, want %d (%s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/workflows/"+prRunID+"/signals/state", strings.NewReader(`{"refreshSince":true}`))
	s.handleWorkflows(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("refreshSince: status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}

	waitFor(t, func() bool {
		return activityCount(t, m, prRunID, "fetchPRStatuses") > before &&
			activityCount(t, m, prRunID, "generateSinceReviewSummary") > 1
	})
	if st, _ := m.engine.Status(prRunID); st != tembed.StatusWaiting && st != tembed.StatusRunning {
		t.Fatalf("tracker = %q, want it still parked on its signal loop", st)
	}
}

// activityCount counts completed runs of one activity in a run's history.
func activityCount(t *testing.T, m *TaskManager, runID, name string) int {
	t.Helper()
	hist, _ := m.engine.History(runID)
	n := 0
	for _, ev := range hist {
		if ev.Type == tembed.EventActivityCompleted && ev.Name == name {
			n++
		}
	}
	return n
}

// signalReceivedCount counts how often a run's history recorded a Signal of
// the given name, so a test can assert "one more Signal landed" without
// caring about its payload.
func signalReceivedCount(t *testing.T, m *TaskManager, runID, name string) int {
	t.Helper()
	hist, err := m.engine.History(runID)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, ev := range hist {
		if ev.Type == tembed.EventSignalReceived && ev.Name == name {
			n++
		}
	}
	return n
}

// TestTriggerIngestRefreshCheckFiresImmediately pins the fix for "opening a
// review tree should check for new commits right away, not wait for
// pollIngestRefresh's own next tick": handlePRStatusStart now calls
// TriggerIngestRefreshCheck on every page load. This drives that call
// directly and asserts the ingest-refresh Signal lands in the pr_status
// tracker's history — with pollIngestRefresh's own ticker parked an hour out,
// so the only way the Signal can appear within the test's timeout is via the
// immediate, on-open check under test. checkIngestRefreshOnce's
// fetchPRMeta/ingestRefreshNeeded have no offline fake (see
// TestIngestWorkflowEndToEnd), so this needs real gh/git access and skips
// itself when that isn't available, exactly like that test.
func TestTriggerIngestRefreshCheckFiresImmediately(t *testing.T) {
	if _, err := exec.Command("gh", "pr", "view", "12903", "--repo", repoSlug, "--json", "number").Output(); err != nil {
		t.Skipf("gh not reachable, skipping: %v", err)
	}
	t.Setenv("SLASH_GITHUB", "off") // fetchPRBasics/generatePRSummary/fetchPRStatuses stay offline

	dataDir := t.TempDir()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, db, dataDir, repoSlug)
	// Park pollIngestRefresh's own ticker far in the future: any refresh
	// Signal observed within the test window must come from
	// TriggerIngestRefreshCheck, never a coincidental regular tick.
	m.interval = time.Hour
	m.idle = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.SetRuntime(ctx, true)

	const pr = 12903
	prRunID, err := m.ensurePRStatus("", pr)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		st, _ := m.engine.Status(prRunID)
		return st == tembed.StatusWaiting
	})

	// Seed a stale recorded head SHA so ingestRefreshNeeded reports "refresh
	// needed" regardless of the PR's real current head.
	if err := saveIngestSHAs(db, "", pr, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "0000000000000000000000000000000000dead"); err != nil {
		t.Fatal(err)
	}
	before := signalReceivedCount(t, m, prRunID, SignalPRState)

	m.TriggerIngestRefreshCheck(prRunID, "", pr)

	waitFor(t, func() bool {
		return signalReceivedCount(t, m, prRunID, SignalPRState) > before
	})
}
