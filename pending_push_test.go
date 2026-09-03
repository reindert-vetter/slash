package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/chat"
)

// pending_push_test.go covers the deferred push: the read model that feeds the
// todo row, the push Activity itself (both outcomes), and the queue dispatch
// that gets there. Same offline harness as chat_checkout_test.go — a
// throwaway bare "origin" plus a local clone SLASH_REPO_DIR points at — so
// nothing here touches the real developer clone or the network.

// landOneEdit lands one file change on pr's pending ref through the real
// commit/land path, cloning a fresh checkout for "the reviewer's own local
// checkout" off the TRUE bare origin — resolved from the shared clone's own
// "origin" remote (SLASH_REPO_DIR itself may have no local branch matching
// headRefName at all, only a remote-tracking ref, if headRefName never was
// the bare repo's default HEAD; a further clone of it would not transfer that
// remote-tracking ref onward — see cloneCheckoutDir's own doc comment).
func landOneEdit(t *testing.T, dataDir string, pr int, conversationID, headRefName, file, content string) {
	t.Helper()
	ctx := context.Background()
	out, err := exec.Command("git", "-C", os.Getenv("SLASH_REPO_DIR"), "remote", "get-url", "origin").Output()
	if err != nil {
		t.Fatalf("resolve shared clone's origin: %v", err)
	}
	bareDir := strings.TrimSpace(string(out))
	dir := cloneCheckoutDir(t, bareDir, headRefName)
	assignCheckoutForTest(t, "", pr, dir)
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := commitCheckoutEditsAt(ctx, testChatModule(t), dataDir, "", pr, conversationID, "turn-"+conversationID, headRefName); msg.Kind == chat.KindError {
		t.Fatalf("landing failed: %+v", msg)
	}
}

// The read model reports what the todo row needs, straight from git: the branch
// to push to, how many commits are waiting, and which files they touch (the
// latter is what marks the affected blocks as unpushed in the UI).
func TestLoadPendingPushReportsLandedWork(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	if v := loadPendingPush(ctx, nil, "", 3001); v != nil {
		t.Fatalf("expected no pending push before anything landed, got %+v", v)
	}

	landOneEdit(t, dataDir, 3001, "conv-a", "feature/x", "foo.txt", "edited by claude\n")

	v := loadPendingPush(ctx, nil, "", 3001)
	if v == nil {
		t.Fatal("expected a pending push after a landing")
	}
	if v.HeadRef != "feature/x" {
		t.Fatalf("headRef = %q, want feature/x", v.HeadRef)
	}
	if v.Ahead != 1 {
		t.Fatalf("ahead = %d, want 1", v.Ahead)
	}
	if v.State != pendingPushReady {
		t.Fatalf("state = %q, want %q", v.State, pendingPushReady)
	}
	if !reflect.DeepEqual(v.Files, []string{"foo.txt"}) {
		t.Fatalf("files = %v, want [foo.txt]", v.Files)
	}
	if v.PushRunID != chatMergeQueueRunID("", 3001) {
		t.Fatalf("pushRunId = %q, want %q", v.PushRunID, chatMergeQueueRunID("", 3001))
	}
}

// TestLoadPendingPushTreeCaughtUpBackstop pins the read model's own,
// git+DB-only view of whether the review tree has actually re-ingested a
// landed chat edit — TreeCaughtUp — independent of whether the blocks.changed
// SSE frame announcing that ever reached a browser tab (see
// .claude/docs/pending-push.md, "Wordt bijgewerkt": that frame is deliberately
// excluded from onEventsResync, and the ordinary ingest-refresh poller can
// never backstop a landed-but-unpushed local commit, since it only reacts to
// the PR's REMOTE head moving). The frontend's own backstop
// (src/home.mjs's loadPendingPush) polls exactly this field instead — this
// test is what proves that field tells the truth regardless of any event.
func TestLoadPendingPushTreeCaughtUpBackstop(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// The shared clone's own HEAD is never checked out to a real branch (see
	// cloneCheckoutDir's own doc comment on the bare repo's default-branch
	// quirk) — origin/feature/x is the seed commit landOneEdit below builds on
	// top of.
	baseOut, err := exec.Command("git", "-C", os.Getenv("SLASH_REPO_DIR"), "rev-parse", "origin/feature/x").Output()
	if err != nil {
		t.Fatal(err)
	}
	baseSHA := strings.TrimSpace(string(baseOut))

	// No prior ingest recorded at all yet: defensively reports caught-up (true)
	// rather than a "still behind" that could never resolve.
	landOneEdit(t, dataDir, 3005, "conv-e", "feature/x", "foo.txt", "edit one\n")
	v := loadPendingPush(ctx, db, "", 3005)
	if v == nil {
		t.Fatal("expected a pending push after landing")
	}
	if !v.TreeCaughtUp {
		t.Fatal("TreeCaughtUp = false with no prior ingest recorded, want true (nothing to backstop yet)")
	}
	landedSHA := v.SHA

	// A prior ingest recorded at an OLDER sha (the tree hasn't re-ingested this
	// landing yet) — the state right after a landing whose refreshIngestDelta
	// Activity either hasn't run yet or whose own blocks.changed frame got
	// dropped on the wire; either way TreeCaughtUp must say "not yet" so the
	// frontend backstop knows to keep waiting rather than treat this as new.
	if err := saveIngestSHAs(db, "", 3005, baseSHA, baseSHA); err != nil {
		t.Fatal(err)
	}
	v = loadPendingPush(ctx, db, "", 3005)
	if v.TreeCaughtUp {
		t.Fatal("TreeCaughtUp = true while pr_ingest still points at the OLD head, want false")
	}

	// The exact scenario this backstop exists for: refreshIngestDelta actually
	// ran and wrote the new head (regardless of whether its blocks.changed frame
	// ever reached a tab) — TreeCaughtUp must flip to true from git+DB state
	// alone, with no event involved at all.
	if err := saveIngestSHAs(db, "", 3005, baseSHA, landedSHA); err != nil {
		t.Fatal(err)
	}
	v = loadPendingPush(ctx, db, "", 3005)
	if !v.TreeCaughtUp {
		t.Fatal("TreeCaughtUp = false after pr_ingest caught up to the landed sha, want true")
	}
}

// A successful push puts the landed commit on the real branch and drops the
// pending ref, which is what makes the todo row disappear.
func TestPushPendingPRPushesAndDropsTheRef(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	landOneEdit(t, dataDir, 3002, "conv-b", "feature/x", "foo.txt", "edited by claude\n")

	pushPendingPR(ctx, nil, "", 3002)

	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	if got, _ := os.ReadFile(filepath.Join(verify, "foo.txt")); string(got) != "edited by claude\n" {
		t.Fatalf("pushed content = %q, want the edit", got)
	}
	if v := loadPendingPush(ctx, nil, "", 3002); v != nil {
		t.Fatalf("pending ref survived a successful push: %+v", v)
	}
}

// A pending ref whose commits are ALREADY on the branch — pushed outside the
// app, or pushed by the app after which dropping the ref failed — is not
// pending work: reporting it kept a stale "ongepusht" pill on every touched
// block forever (reviewer report). The ref may survive; the read model must
// not report it.
func TestLoadPendingPushIgnoresARefAlreadyOnTheBranch(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	landOneEdit(t, dataDir, 3005, "conv-e", "feature/x", "foo.txt", "edited by claude\n")
	if loadPendingPush(ctx, nil, "", 3005) == nil {
		t.Fatal("expected a pending push right after the landing")
	}

	// Push it the way the reviewer would from his own checkout: the commit
	// lands on the branch (and origin/feature/x moves with it), but the app's
	// own pending ref is left exactly where it was.
	ref, _ := pendingPushRefFor(ctx, "", 3005)
	if out, err := runGitFor(ctx, "", "push", "origin", ref+":refs/heads/feature/x"); err != nil {
		t.Fatalf("push outside the app: %v: %s", err, out)
	}
	if sha := pendingRefSHA(ctx, "", ref); sha == "" {
		t.Fatal("test setup: the pending ref should still exist")
	}

	if v := loadPendingPush(ctx, nil, "", 3005); v != nil {
		t.Fatalf("read model still reports an already-pushed ref: %+v", v)
	}
}

// A non-primary repo's pending ref carries its key as an extra path segment
// (chat_checkout.go's prPendingRef) — this must be exactly the prefix
// pendingPushRefFor/removePendingRefs enumerate, via the single shared
// pendingRefPrefix, or a second repo's landed edit would never be found (nor
// swept by cleanup). Regression for a real drift between the two.
func TestLoadPendingPushFindsANonPrimaryRepo(t *testing.T) {
	bareDir, cloneDir := setupChatShadowRepo(t, "feature/x", "v1\n")
	writeSettings(t, `{"repos":[
		{"slug":"plug-and-pay/plug-and-pay","key":"pap","primary":true},
		{"slug":"plug-and-pay/plug-and-pay-ops","key":"ops","dir":"`+cloneDir+`","baseBranch":"master"}
	]}`)
	const ops = "plug-and-pay/plug-and-pay-ops"
	dataDir := t.TempDir()
	ctx := context.Background()

	if v := loadPendingPush(ctx, nil, ops, 12); v != nil {
		t.Fatalf("expected no pending push before anything landed, got %+v", v)
	}

	dir := cloneCheckoutDir(t, bareDir, "feature/x")
	assignCheckoutForTest(t, ops, 12, dir)
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := commitCheckoutEditsAt(ctx, testChatModule(t), dataDir, ops, 12, "conv-ops", "turn-ops", "feature/x"); msg.Kind == chat.KindError {
		t.Fatalf("landing failed: %+v", msg)
	}

	v := loadPendingPush(ctx, nil, ops, 12)
	if v == nil {
		t.Fatal("expected a pending push after a landing on the second repo")
	}
	if v.HeadRef != "feature/x" {
		t.Fatalf("headRef = %q, want feature/x", v.HeadRef)
	}

	removePendingRefs(ctx, ops, 12)
	if v := loadPendingPush(ctx, nil, ops, 12); v != nil {
		t.Fatalf("pending ref survived removePendingRefs: %+v", v)
	}
}

// A push the remote refuses (someone else pushed meanwhile) must never force
// anything: the ref is KEPT so the reviewer can merge and retry, and the row
// reports a failure with an actionable reason.
func TestPushPendingPRKeepsRefWhenRefused(t *testing.T) {
	bareDir, _ := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	landOneEdit(t, dataDir, 3003, "conv-c", "feature/x", "foo.txt", "edited by claude\n")
	// Only now does someone else push, so our pending ref is no longer a
	// fast-forward of the branch.
	pushToBare(t, bareDir, "feature/x", "someone else\n")

	pushPendingPR(ctx, nil, "", 3003)

	v := loadPendingPush(ctx, nil, "", 3003)
	if v == nil {
		t.Fatal("pending ref was dropped even though the push was refused")
	}
	if v.State != pendingPushFailed {
		t.Fatalf("state = %q, want %q", v.State, pendingPushFailed)
	}
	if v.Error == "" {
		t.Fatal("expected a reason the reviewer can act on")
	}

	// And the remote must be exactly what the other party pushed — untouched.
	verify := t.TempDir()
	if out, err := exec.Command("git", "clone", "--branch", "feature/x", bareDir, verify).CombinedOutput(); err != nil {
		t.Fatalf("clone to verify: %v: %s", err, out)
	}
	if got, _ := os.ReadFile(filepath.Join(verify, "foo.txt")); string(got) != "someone else\n" {
		t.Fatalf("remote content = %q, want it untouched by the refused push", got)
	}
}

// The queue dispatches on the Signal's own Action: a "push" request runs
// pushPendingPR and never the landing path, and both kinds keep sharing one
// Execution (so a push can never overlap a landing for the same PR).
func TestChatMergeQueueDispatchesPushAction(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	engine.RegisterWorkflow(WorkflowChatMerge, chatMergeQueueWorkflow)

	var mu sync.Mutex
	var calls []string
	engine.RegisterActivity("processChatMerge", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatMergeInput
		_ = json.Unmarshal(in, &arg)
		mu.Lock()
		calls = append(calls, "land:"+arg.ConversationID)
		mu.Unlock()
		return nil, nil
	})
	engine.RegisterActivity("pushPendingPR", func(ctx context.Context, in []byte) ([]byte, error) {
		var arg chatMergeInput
		_ = json.Unmarshal(in, &arg)
		mu.Lock()
		calls = append(calls, "push")
		mu.Unlock()
		if arg.PR != 9003 {
			t.Errorf("push Activity got pr %d, want 9003", arg.PR)
		}
		return nil, nil
	})

	runID, err := engine.StartWorkflowID(chatMergeQueueRunID("", 9003), WorkflowChatMerge, ChatMergeQueueInput{PR: 9003})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalChatMerge, ChatMergeRequest{ConversationID: "conv-1"}); err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalChatMerge, ChatMergeRequest{Action: chatMergeActionPush}); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	got := append([]string(nil), calls...)
	mu.Unlock()
	if want := []string{"land:conv-1", "push"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("activities = %v, want %v", got, want)
	}
}

// TestHandleWorkflowsPushSignal pins the UI's own path to the "push" Action:
// POST /api/workflows/{runID}/signals/merge, exactly what pushPendingWork
// (src/home.mjs) sends. This route used to fall through to handleWorkflows'
// "unknown signal" 400 — the chat_merge queue's own SignalChatMerge ("merge")
// had no case in that dispatcher, so a reviewer's "push" click silently never
// reached the workflow at all, even though the queue itself (tested above) and
// the git-level Activity (TestPushPendingPRPushesAndDropsTheRef) both worked
// fine in isolation. Also pins that the "land" Action (empty string, only ever
// sent cross-workflow via enqueueChatMerge) is rejected here rather than
// silently accepted with no ConversationID.
func TestHandleWorkflowsPushSignal(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	landOneEdit(t, dataDir, 3004, "conv-d", "feature/x", "foo.txt", "edited by claude\n")

	m, _, _ := newTestManager(t)
	s := &server{tasks: &tasks{manager: m, engine: m.engine}}
	runID, err := m.EnsureChatMergeQueue("", 3004)
	if err != nil {
		t.Fatal(err)
	}

	// A "land" Action from the outside is rejected, not silently accepted.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/workflows/"+runID+"/signals/merge", strings.NewReader(`{"action":""}`))
	s.handleWorkflows(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("land action: status = %d, want %d (%s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}

	// The real "push" Action reaches the queue.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/workflows/"+runID+"/signals/merge", strings.NewReader(`{"action":"push"}`))
	s.handleWorkflows(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("push action: status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}

	if v := loadPendingPush(context.Background(), nil, "", 3004); v != nil {
		t.Fatalf("pending ref survived a push routed through handleWorkflows: %+v", v)
	}
}

// TestHandleChatMergeStartAndCheckoutRead pins the checkout chip's own two
// endpoints: POST /api/workflows/chat_merge (ensure the queue Execution even
// though nothing has landed/relisted for this PR yet) and
// GET /api/chat/checkout (the batch read the chip/PR-overview badge use) —
// plus that the checkout-menu Actions on the merge Signal are validated the
// same way the existing "push" Action already is (TestHandleWorkflowsPushSignal).
func TestHandleChatMergeStartAndCheckoutRead(t *testing.T) {
	m, _, _ := newTestManager(t)
	s := &server{tasks: &tasks{manager: m, engine: m.engine}}

	// Ensure works even for a PR with no prior chat_merge activity at all.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/workflows/chat_merge", strings.NewReader(`{"pr":4001}`))
	s.handleChatMergeStart(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("ensure: status = %d (%s)", rec.Code, rec.Body.String())
	}
	var ensureBody struct {
		RunID string `json:"runId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ensureBody); err != nil || ensureBody.RunID == "" {
		t.Fatalf("ensure response = %s", rec.Body.String())
	}
	if ensureBody.RunID != chatMergeQueueRunID("", 4001) {
		t.Fatalf("runId = %q, want %q", ensureBody.RunID, chatMergeQueueRunID("", 4001))
	}

	// A checkoutOff Action reaches the now-ensured queue without error, even
	// with nothing assigned (a no-op, not a failure).
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/workflows/"+ensureBody.RunID+"/signals/merge", strings.NewReader(`{"action":"checkoutOff"}`))
	s.handleWorkflows(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("checkoutOff: status = %d (%s)", rec.Code, rec.Body.String())
	}

	// checkoutAnswer with an empty reply is rejected, same "invalid action"
	// shape as an unrecognized Action string.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/workflows/"+ensureBody.RunID+"/signals/merge", strings.NewReader(`{"action":"checkoutAnswer"}`))
	s.handleWorkflows(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("checkoutAnswer with no reply: status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	// The read side: GET /api/chat/checkout always returns a (possibly empty)
	// view, keyed the same way /api/pending-push is.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/chat/checkout?prs=4001", nil)
	s.handleChatCheckout(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("read: status = %d (%s)", rec.Code, rec.Body.String())
	}
	var readBody struct {
		OK       bool                    `json:"ok"`
		Checkout map[string]checkoutView `json:"checkout"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &readBody); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	view, ok := readBody.Checkout["4001"]
	if !ok {
		t.Fatalf("expected a view for pr 4001, got %+v", readBody.Checkout)
	}
	if view.RunID != ensureBody.RunID {
		t.Fatalf("view.RunID = %q, want %q", view.RunID, ensureBody.RunID)
	}
}

// A landing the reviewer pushed HIMSELF, from outside slash, is not pending any
// more — even though this clone's own origin/<headRef> knows nothing about it.
//
// The regression this pins (reviewer report: "waarom staan hier zoveel niet
// gepusht, terwijl ik alles heb gepusht 5 minuten geleden"): the read model
// used to decide purely on origin/<headRef>, and nothing in slash ever
// refreshes that remote-tracking ref — ensureCommits fetches refs/pull/<n>/head
// (which does not move it) and the chat checkout fetches in the reviewer's own
// checkout, not here. On the real PR it was six days and 293 commits behind, so
// every pushed commit still counted as pending and the "ongepusht" pill landed
// on nearly every file in the PR. loadPendingPush now asks the remote itself
// (remoteHeadSHA, a throttled `git ls-remote` that writes nothing).
func TestLoadPendingPushSeesAnOutsidePush(t *testing.T) {
	bareDir, cloneDir := setupChatShadowRepo(t, "feature/x", "v1\n")
	dataDir := t.TempDir()
	ctx := context.Background()

	landOneEdit(t, dataDir, 3009, "conv-out", "feature/x", "foo.txt", "edited by claude\n")

	v := loadPendingPush(ctx, nil, "", 3009)
	if v == nil {
		t.Fatal("expected a pending push after a landing")
	}
	landedSHA := v.SHA

	// The reviewer pushes that exact commit himself, from a checkout of his own
	// — never through this clone, so its origin/feature/x stays where it was.
	pushLandedCommitFromElsewhere(t, bareDir, cloneDir, "feature/x", landedSHA)

	stale := staleRemoteTrackingSHA(t, cloneDir, "feature/x")
	if stale == landedSHA {
		t.Fatalf("fixture broken: origin/feature/x already moved to the landed commit %s", landedSHA)
	}

	remoteHeadCache.Lock()
	remoteHeadCache.byPR = map[prKey]remoteHeadEntry{}
	remoteHeadCache.Unlock()

	if v := loadPendingPush(ctx, nil, "", 3009); v != nil {
		t.Fatalf("expected no pending push once the branch was pushed elsewhere, got %+v", v)
	}
	if got := staleRemoteTrackingSHA(t, cloneDir, "feature/x"); got != stale {
		t.Fatalf("origin/feature/x moved to %s: the read model must not write to the clone", got)
	}
}

// pushLandedCommitFromElsewhere puts one specific commit — living only on this
// clone's pending ref — onto the bare origin's branch, without that clone ever
// being the one pushing (so its own remote-tracking ref stays untouched).
func pushLandedCommitFromElsewhere(t *testing.T, bareDir, cloneDir, headRefName, sha string) {
	t.Helper()
	other := filepath.Join(t.TempDir(), "elsewhere")
	if out, err := exec.Command("git", "clone", bareDir, other).CombinedOutput(); err != nil {
		t.Fatalf("clone elsewhere: %v: %s", err, out)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", other}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("fetch", cloneDir, sha)
	run("push", "origin", sha+":refs/heads/"+headRefName)
}

// staleRemoteTrackingSHA reads the clone's own origin/<branch> — the ref the
// read model used to trust blindly.
func staleRemoteTrackingSHA(t *testing.T, cloneDir, headRefName string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", cloneDir, "rev-parse", "origin/"+headRefName).Output()
	if err != nil {
		t.Fatalf("rev-parse origin/%s: %v", headRefName, err)
	}
	return strings.TrimSpace(string(out))
}

// TestLoadPendingPushIgnoresAMergeSupersededByASeparateRemoteMerge covers a
// merge-only pending commit (e.g. a chat turn running `git merge
// origin/develop` through the Bash carve-out) whose real content already
// reached the remote through a DIFFERENT, later merge of the same mainline
// branch — real case found live on PR 13628 (INTEG-467): the reviewer's own
// work had long since reached GitHub, but GitHub's branch was separately
// updated with its own merge of develop (e.g. via the "Update branch"
// button), so the pending merge could never become an ancestor of the new
// remote tip (git never reuses another merge's SHA) and the ahead-count could
// never reach 0 on its own — a permanently stuck "ongepusht" pill despite
// nothing real left to push.
func TestLoadPendingPushIgnoresAMergeSupersededByASeparateRemoteMerge(t *testing.T) {
	bareDir, cloneDir := setupChatShadowRepo(t, "feature/x", "v1\n")
	ctx := context.Background()

	developSHA := addBranchCommit(t, bareDir, "feature/x", "develop", "dev.txt", "from develop\n")

	// The pending commit: locally merge origin/develop into feature/x — the
	// shape a `git merge origin/develop` chat turn produces — landed directly
	// on the pending ref (the ordinary landing path only ever commits a plain
	// edit, never a merge, so this bypasses it on purpose).
	mergeSHA := mergeBranchIntoClone(t, cloneDir, "feature/x", "develop")
	pendingRef := prPendingRef("", 3628, "feature/x")
	runInDir(t, cloneDir, "update-ref", pendingRef, mergeSHA)

	if v := loadPendingPush(ctx, nil, "", 3628); v == nil {
		t.Fatal("expected a pending push right after landing the merge")
	}

	// GitHub gets the SAME two ingredients (the branch's own tip and develop's
	// tip) merged in independently — a different commit, since git never
	// reuses another merge's SHA.
	supersedingSHA := pushSupersedingMerge(t, bareDir, "feature/x", developSHA)
	// The read model only trusts a remote SHA it can resolve LOCALLY
	// (pendingRefSHA(remote)) — in production that object is already present
	// because ensureCommits (gh.go) fetches the PR's current head by SHA on
	// every ingest, well before a reviewer ever looks at the pending-push row.
	// Mirror that here explicitly, since this fixture's ingest never runs.
	runInDir(t, cloneDir, "fetch", "origin", supersedingSHA)

	remoteHeadCache.Lock()
	remoteHeadCache.byPR = map[prKey]remoteHeadEntry{}
	remoteHeadCache.Unlock()

	if v := loadPendingPush(ctx, nil, "", 3628); v != nil {
		t.Fatalf("expected the superseded merge to report nothing pending, got %+v", v)
	}
}

// addBranchCommit creates a new branch off fromRefName's current tip, adds
// one commit to it, and pushes it — a throwaway "develop" diverging from the
// same seed commit setupChatShadowRepo already pushed on fromRefName.
// Returns the new branch tip's SHA.
func addBranchCommit(t *testing.T, bareDir, fromRefName, branchName, file, content string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "seed-"+branchName)
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if _, err := exec.Command("git", "clone", "--branch", fromRefName, bareDir, dir).CombinedOutput(); err != nil {
		t.Fatalf("clone: %v", err)
	}
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	run("checkout", "-b", branchName)
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", file)
	run("commit", "-m", "on "+branchName)
	run("push", "origin", branchName)
	return run("rev-parse", "HEAD")
}

// mergeBranchIntoClone fetches otherBranch into the shared clone and merges
// it (--no-ff, so a real two-parent merge commit results) into headRefName.
// Returns the merge commit's SHA. Checks out headRefName from
// origin/headRefName first — the bare repo's own default HEAD need not be
// headRefName (see TestLoadPendingPushTreeCaughtUpBackstop's own doc comment
// on that quirk), so the clone's HEAD after a plain `git clone` can otherwise
// be an unborn branch with nothing to merge into.
func mergeBranchIntoClone(t *testing.T, cloneDir, headRefName, otherBranch string) string {
	t.Helper()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", cloneDir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), cloneDir, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("checkout", "-B", headRefName, "origin/"+headRefName)
	run("fetch", "origin", otherBranch)
	run("merge", "--no-ff", "-m", "Merge origin/"+otherBranch, "origin/"+otherBranch)
	return run("rev-parse", "HEAD")
}

// pushSupersedingMerge pushes an INDEPENDENT merge of otherBranch's SHA into
// headRefName straight onto the bare origin, from a throwaway third clone —
// standing in for "GitHub's own Update-branch merge", never touching the
// shared clone this test's pending ref lives in.
func pushSupersedingMerge(t *testing.T, bareDir, headRefName, otherSHA string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "github-update-branch")
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if _, err := exec.Command("git", "clone", "--branch", headRefName, bareDir, dir).CombinedOutput(); err != nil {
		t.Fatalf("clone: %v", err)
	}
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	run("fetch", "origin", otherSHA)
	run("merge", "--no-ff", "-m", "Merge remote-tracking branch into "+headRefName, otherSHA)
	run("push", "origin", headRefName)
	return run("rev-parse", "HEAD")
}

// runInDir runs one git command in dir, failing the test on error — the
// generic version of the ad hoc `run` closures every other helper in this
// file defines, used where the caller only needs a single command.
func runInDir(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}
