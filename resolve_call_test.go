package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/callresolve"
	"slash/modules/claude"
	"slash/modules/github"
)

// resolveCallManager wires a TaskManager with a callresolve module + a claude
// Fake over the writeCallFixtureRepo worktree, for driving resolve_call.
func resolveCallManager(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *callresolve.Module) {
	t.Helper()
	cr, err := callresolve.Open(filepath.Join(dataDir, "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cr.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), cr, nil, nil, nil, nil, fake, nil, nil, dataDir, "test/repo")
	return m, cr
}

func callInput(pr int, calls ...string) ResolveCallInput {
	return ResolveCallInput{
		PR: pr, CallerID: "x", CallerFile: "app/Services/OrderService.php",
		CallerClass: "OrderService", CallerName: "build", Calls: calls,
	}
}

// Haiku is confident → found, using only Haiku.
func TestResolveCallHaikuConfident(t *testing.T) {
	dataDir := t.TempDir()
	pr := 21
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Models/Order.php","class":"Order","method":"scopeJoinAddress","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "joinAddress")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusFound || e.Model != callresolve.ModelHaiku {
		t.Fatalf("entry = %+v, want found by haiku", e)
	}
	if e.ChildCode == "" {
		t.Fatalf("found entry has empty child code")
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1", n)
	}
}

// TestResolveCallHaikuFoundFoldsLeadingPHPDoc: an LLM-found child whose
// definition carries a leading PHPDoc gets the same @return/@param signature
// fold applied to its embedded ChildCode (via verifyDefinition ->
// enrichedCodeSide) that an active (changed) block's diff gets via /api/code
// — see codesig.go and .claude/rules/blocks-and-ingest.md ("PHPDoc-types in
// de signatuur vouwen"). ChildLine must shift by the same removed-line count.
func TestResolveCallHaikuFoundFoldsLeadingPHPDoc(t *testing.T) {
	dataDir := t.TempDir()
	pr := 29
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Services/OrderService.php": `<?php
namespace App\Services;
class OrderService {
    public function build() {
        Helper::compute($this->items);
    }
}
`,
		"app/Support/Helper.php": "<?php\n" +
			"namespace App\\Support;\n" +
			"class Helper {\n" +
			"    /**\n" +
			"     * @param array $items\n" +
			"     * @return array\n" +
			"     */\n" +
			"    public static function compute($items)\n" +
			"    {\n" +
			"        return $items;\n" +
			"    }\n" +
			"}\n",
	}
	for rel, body := range files {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Support/Helper.php","class":"Helper","method":"compute","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "compute")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusFound {
		t.Fatalf("entry = %+v, want found", e)
	}
	if strings.Contains(e.ChildCode, "/**") || strings.Contains(e.ChildCode, "@param") {
		t.Errorf("ChildCode still carries the PHPDoc, got %q", e.ChildCode)
	}
	if !strings.Contains(e.ChildCode, "function compute(array $items): array") {
		t.Errorf("ChildCode signature not folded, got %q", e.ChildCode)
	}
	if e.ChildLine != 8 {
		t.Errorf("ChildLine = %d, want 8 (the doc's 4 removed lines shift the def from line 4 to line 8)", e.ChildLine)
	}
}

// Haiku is not confident → the workflow never escalates to Sonnet: it uses
// ONLY Haiku, so an unconfident Haiku answer stays notfound even though a
// programmed Sonnet output would have found it.
func TestResolveCallNeverEscalatesToSonnet(t *testing.T) {
	dataDir := t.TempDir()
	pr := 22
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":false,"confidence":"low"}`)
	fake.SetOutput(claude.ModelSonnet, `{"found":true,"file":"app/Repos/RepoA.php","class":"RepoA","method":"fetch","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "fetch")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (no Sonnet escalation)", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (Haiku only, no Sonnet call at all)", n)
	}
}

// A call with zero static candidates (nothing in the fixture worktree defines
// "someUnknownHelper") behaves the same as any other unconfident Haiku answer
// now that there is no escalation path at all.
func TestResolveCallNoEscalationWithoutCandidates(t *testing.T) {
	dataDir := t.TempDir()
	pr := 25
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":false,"confidence":"low"}`)
	fake.SetOutput(claude.ModelSonnet, `{"found":true,"file":"app/Repos/RepoA.php","class":"RepoA","method":"fetch","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "someUnknownHelper")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (no escalation without candidates)", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (Haiku only, no Sonnet escalation)", n)
	}
}

// A denylisted vendor/framework builtin (assertStatus) with zero static
// candidates never even reaches Haiku: the whole point of the denylist is to
// skip the LLM call entirely for a name that can never resolve.
func TestResolveCallVendorBuiltinSkipsLLM(t *testing.T) {
	dataDir := t.TempDir()
	pr := 27
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	// Programmed outputs would make this call "resolve" if the LLM were
	// invoked at all — proving the skip, not just an absence of output.
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Repos/RepoA.php","class":"RepoA","method":"fetch","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "assertStatus")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (vendor builtin never resolves)", e)
	}
	if n := fake.CallCount(); n != 0 {
		t.Fatalf("claude called %d times, want 0 (vendor builtin skips the LLM entirely)", n)
	}
}

// The same denylisted name ("table") resolves normally once the app
// worktree actually defines it — the denylist gate only ever fires on
// len(candidates)==0, so it must never suppress a genuine app-defined match
// that merely happens to share a name with a Schema Blueprint builtin.
func TestResolveCallVendorBuiltinDoesNotSuppressRealCandidate(t *testing.T) {
	dataDir := t.TempDir()
	pr := 28
	writeCallFixtureRepo(t, dataDir, pr)
	_, headDir := worktreeDirs(dataDir, pr)
	// Add an app class that defines its own "table" method — same name as
	// the denylisted Schema Blueprint builtin, but a real app candidate.
	tableFile := filepath.Join(headDir, "app/Reports/ReportBuilder.php")
	if err := os.MkdirAll(filepath.Dir(tableFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tableFile, []byte(`<?php
namespace App\Reports;
class ReportBuilder {
    public function table() {}
}
`), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Reports/ReportBuilder.php","class":"ReportBuilder","method":"table","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "table")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusFound || e.Model != callresolve.ModelHaiku {
		t.Fatalf("entry = %+v, want found by haiku (real app candidate must not be suppressed)", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (denylist must not skip a call with a real candidate)", n)
	}
}

// Neither model finds it (offline/empty Fake output) → notfound.
func TestResolveCallNotFound(t *testing.T) {
	dataDir := t.TempDir()
	pr := 23
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake() // no programmed output → "" → parse fails → notfound
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "fetch")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound", e)
	}
}

// A model claiming a definition that does not exist in the worktree is rejected
// by verification → notfound (guards against a hallucinated file/method).
func TestResolveCallVerificationRejectsBogus(t *testing.T) {
	dataDir := t.TempDir()
	pr := 24
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Models/Ghost.php","class":"Ghost","method":"boo","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "joinAddress")); err != nil {
		t.Fatal(err)
	}
	if e := onlyEntry(t, cr, pr); e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (bogus claim rejected)", e)
	}
}

func onlyEntry(t *testing.T, cr *callresolve.Module, pr int) callresolve.Entry {
	t.Helper()
	list, err := cr.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("callresolve has %d rows, want 1: %+v", len(list), list)
	}
	return list[0]
}

func mustCallresolveList(t *testing.T, cr *callresolve.Module, pr int) []callresolve.Entry {
	t.Helper()
	list, err := cr.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

// --- groupUnresolvedCalls (pure, no engine/goroutine) ---

// One start per caller: a resolved call is excluded (not Unresolved), a call
// whose caller block isn't in blocks is skipped, and a call already submitted
// to a resolve_call Execution before (via attempted — a durable, ever-tried
// set, see resolveCallAttempted) is skipped too — a rebuild must never
// resubmit a call the LLM already attempted.
func TestGroupUnresolvedCalls(t *testing.T) {
	callerA := Block{PR: 1, File: "app/Services/A.php", Class: "A", Name: "run"}
	callerB := Block{PR: 1, File: "app/Services/B.php", Class: "B", Name: "go"}
	blocks := []Block{callerA, callerB}

	calls := []callresolve.Entry{
		{PR: 1, CallerID: callerA.ID(), CallKey: "y", Status: callresolve.StatusUnresolved},
		{PR: 1, CallerID: callerA.ID(), CallKey: "x", Status: callresolve.StatusUnresolved},
		{PR: 1, CallerID: callerA.ID(), CallKey: "z", Status: callresolve.StatusResolved}, // resolved: excluded
		{PR: 1, CallerID: callerB.ID(), CallKey: "w", Status: callresolve.StatusUnresolved},
		// No block for this caller id — must be skipped defensively.
		{PR: 1, CallerID: "1:app/Ghost.php:Ghost::boo", CallKey: "gone", Status: callresolve.StatusUnresolved},
	}
	attempted := map[string]bool{
		callerB.ID() + "\x1f" + "w": true, // already tried before — skip
	}

	got := groupUnresolvedCalls(1, calls, attempted, blocks)
	if len(got) != 1 {
		t.Fatalf("groupUnresolvedCalls returned %d group(s), want 1: %+v", len(got), got)
	}
	g := got[0]
	if g.CallerID != callerA.ID() || g.CallerFile != callerA.File || g.CallerClass != callerA.Class || g.CallerName != callerA.Name {
		t.Fatalf("group caller fields = %+v, want caller A's fields", g)
	}
	if len(g.Calls) != 2 || g.Calls[0] != "x" || g.Calls[1] != "y" {
		t.Fatalf("group.Calls = %v, want sorted [x y]", g.Calls)
	}
}

// A call that was never attempted before (absent from attempted) stays
// eligible, even if it's the only call for its caller.
func TestGroupUnresolvedCallsKeepsNeverAttemptedCall(t *testing.T) {
	caller := Block{PR: 1, File: "app/Services/A.php", Class: "A", Name: "run"}
	calls := []callresolve.Entry{
		{PR: 1, CallerID: caller.ID(), CallKey: "x", Status: callresolve.StatusUnresolved},
	}

	got := groupUnresolvedCalls(1, calls, map[string]bool{}, []Block{caller})
	if len(got) != 1 || len(got[0].Calls) != 1 || got[0].Calls[0] != "x" {
		t.Fatalf("groupUnresolvedCalls = %+v, want one group with call x", got)
	}
}

// resolveCallRunID: sorting Calls makes the ID independent of build order
// (a Go map iteration, or whatever order a caller happened to send), while a
// genuinely different Calls set (a new unresolved call) yields a fresh ID.
func TestResolveCallRunIDStableAndSensitive(t *testing.T) {
	a := ResolveCallInput{PR: 1, CallerID: "c", Calls: []string{"a", "b"}}
	b := ResolveCallInput{PR: 1, CallerID: "c", Calls: []string{"b", "a"}}
	if resolveCallRunID(a) != resolveCallRunID(b) {
		t.Fatalf("resolveCallRunID depends on Calls order: %s != %s", resolveCallRunID(a), resolveCallRunID(b))
	}
	c := ResolveCallInput{PR: 1, CallerID: "c", Calls: []string{"a", "b", "new"}}
	if resolveCallRunID(a) == resolveCallRunID(c) {
		t.Fatal("resolveCallRunID does not change for a different Calls set")
	}
}

// --- The automatic server-side trigger, end to end via buildRelations ---

// autoResolveCallManager wires a TaskManager with a real DB (so blocksByPR
// works inside the buildRelations Activity), relations + callresolve modules,
// and a claude Fake — everything the automatic resolve_call trigger needs.
func autoResolveCallManager(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *sql.DB, *callresolve.Module) {
	t.Helper()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cr, err := callresolve.Open(filepath.Join(dataDir, "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cr.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), cr, nil, nil, nil, nil, fake, nil, db, dataDir, "test/repo")
	return m, db, cr
}

// (a) EnsureRelations (the buildRelations Activity) starts a search for a
// Go-unresolved call automatically, without the frontend ever calling
// POST /api/workflows/resolve_call. (b) A rebuild with nothing changed never
// re-spends an LLM call — even though the call ended up "notfound" and
// UpsertGo resets a notfound row back to "unresolved" on that very rebuild;
// resolveCallAttempted's durable, history-based set (not the callresolve
// read-model's own fluctuating status) is what prevents the resubmit, and it
// keeps holding across further rebuilds too, not just the one right after a
// search. (c) A genuinely new unresolved call that appears after an edit gets
// its own fresh search, while the already-searched calls are left alone.
//
// writeCallFixtureRepo's OrderService::build has TWO Go-unresolved calls
// ("fetch" — ambiguous between RepoA/RepoB — and "query", Order::query(), a
// vendor Eloquent method never defined in the app worktree), grouped into ONE
// resolve_call Execution for that one caller; resolveCallsWithModel asks the
// (fake) LLM once per call key, so the Fake's call count tracks 2 per fresh
// caller-level search, not 1.
func TestAutoStartResolveCallOnBuildRelations(t *testing.T) {
	dataDir := t.TempDir()
	pr := 210
	writeCallFixtureRepo(t, dataDir, pr)
	caller := Block{PR: pr, File: "app/Services/OrderService.php", Class: "OrderService", Name: "build", Side: SideNew, Status: StatusModified}

	fake := claude.NewFake() // no programmed output → every search ends in "notfound"
	m, db, cr := autoResolveCallManager(t, dataDir, fake)
	if err := replacePRBlocks(db, pr, []Block{caller}); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	m.EnsureRelations(ctx, pr) // must return without waiting for the auto-search

	waitFor(t, func() bool {
		e, ok := findEntry(mustCallresolveList(t, cr, pr), "fetch")
		return ok && e.Status == callresolve.StatusNotfound
	})
	if e, ok := findEntry(mustCallresolveList(t, cr, pr), "fetch"); !ok || e.Status != callresolve.StatusNotfound {
		t.Fatalf("fetch entry = %+v, want notfound", e)
	}
	if e, ok := findEntry(mustCallresolveList(t, cr, pr), "query"); !ok || e.Status != callresolve.StatusNotfound {
		t.Fatalf("query entry = %+v, want notfound", e)
	}
	if n := fake.CallCount(); n != 2 {
		t.Fatalf("claude called %d time(s) after the first build, want 2 (fetch + query)", n)
	}

	// Rebuild with nothing changed: the Go rescan still emits "fetch"/"query"
	// as unresolved (it doesn't know about the DB's LLM state) and UpsertGo
	// resets both notfound rows back to unresolved — but the auto-trigger
	// must not search either one again.
	m.EnsureRelations(ctx, pr)
	// Nothing SHOULD happen here (both calls were already attempted), so there
	// is no positive condition to poll for — give any (wrongly re-triggered)
	// background search a moment to run before asserting the count didn't grow.
	time.Sleep(50 * time.Millisecond)
	if n := fake.CallCount(); n != 2 {
		t.Fatalf("claude called %d time(s) after a no-op rebuild, want still 2 (no duplicate search)", n)
	}

	// A genuinely new unresolved call appears in the same caller.
	_, headDir := worktreeDirs(dataDir, pr)
	callerFile := filepath.Join(headDir, "app/Services/OrderService.php")
	body, err := os.ReadFile(callerFile)
	if err != nil {
		t.Fatal(err)
	}
	updated := strings.Replace(string(body), "$this->repo->fetch();",
		"$this->repo->fetch();\n        $this->repo->fetchNew();", 1)
	if updated == string(body) {
		t.Fatal("fixture line not found, test setup is stale")
	}
	if err := os.WriteFile(callerFile, []byte(updated), 0o644); err != nil {
		t.Fatal(err)
	}

	m.EnsureRelations(ctx, pr)
	waitFor(t, func() bool {
		e, ok := findEntry(mustCallresolveList(t, cr, pr), "fetchNew")
		return ok && e.Status == callresolve.StatusNotfound
	})
	// Exactly one more claude call — for "fetchNew" only. "fetch"/"query"
	// legitimately show "unresolved" again in the read-model at this point
	// (this build's own UpsertGo just reset them, same as after the no-op
	// rebuild above) — that's cosmetic, pre-existing UpsertGo behavior; the
	// actual guarantee under test is that they were NOT resubmitted to the
	// LLM, which the call count below proves.
	if n := fake.CallCount(); n != 3 {
		t.Fatalf("claude called %d time(s) after the new call appeared, want 3 (only the new call searched)", n)
	}
}
